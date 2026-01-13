const API_BASE = '/api';

// DOM Elements
const fileInput = document.getElementById('file-input');
const fileName = document.getElementById('file-name');
const uploadBtn = document.getElementById('upload-btn');
const uploadForm = document.getElementById('upload-form');
const uploadProgress = document.getElementById('upload-progress');
const progressFill = uploadProgress.querySelector('.progress-fill');
const progressText = uploadProgress.querySelector('.progress-text');
const cancelBtn = document.getElementById('cancel-btn');
const filesList = document.getElementById('files-list');
const toast = document.getElementById('toast');

// Upload state for cancellation
let currentUpload = {
  xhr: null,
  fileId: null,
  cancelled: false,
};

// Show toast notification
function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = 'toast ' + type + ' show';
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// Format date
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Load files list
async function loadFiles() {
  try {
    const response = await fetch(API_BASE + '/files');
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error);
    }
    
    if (data.files.length === 0) {
      filesList.innerHTML = '<p class="empty">No files uploaded yet</p>';
      return;
    }
    
    filesList.innerHTML = data.files.map(file => {
      const partsInfo = file.totalParts > 1 ? ' (' + file.totalParts + ' parts)' : '';
      return '<div class="file-item" data-id="' + file.id + '">' +
        '<div class="file-info">' +
          '<div class="file-name">' + escapeHtml(file.originalName) + '</div>' +
          '<div class="file-meta">' + file.sizeFormatted + partsInfo + ' - ' + formatDate(file.createdAt) + '</div>' +
        '</div>' +
        '<div class="file-actions">' +
          '<a href="' + API_BASE + '/files/' + file.id + '/download" class="btn btn-download">Download</a>' +
          '<button class="btn btn-danger" onclick="deleteFile(' + file.id + ')">Delete</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (error) {
    filesList.innerHTML = '<p class="empty">Failed to load files: ' + error.message + '</p>';
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Upload file with real-time progress:
// - Browser -> Server: Tracked via XHR upload progress (0-50%)
// - Server -> Discord: Tracked via SSE streaming (50-100%)
async function uploadFile(file) {
  uploadProgress.hidden = false;
  uploadBtn.disabled = true;
  fileInput.disabled = true;
  cancelBtn.hidden = false; // Show cancel button immediately
  progressFill.style.width = '0%';
  progressText.textContent = 'Uploading to server...';

  // Reset upload state
  currentUpload = { xhr: null, fileId: null, cancelled: false };

  try {
    // Single XHR request with both upload progress and streaming response
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      currentUpload.xhr = xhr;

      const formData = new FormData();
      formData.append('file', file);

      let receivedLength = 0;
      let buffer = '';
      let lastError = null;
      let uploadComplete = false;

      // Track upload progress (0-50%)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 50);
          progressFill.style.width = percent + '%';
          progressText.textContent = 'Uploading to server... ' + Math.round((e.loaded / e.total) * 100) + '%';
        }
      };

      xhr.upload.onload = () => {
        uploadComplete = true;
        progressFill.style.width = '50%';
        progressText.textContent = 'Processing...';
        console.log('[Upload] Browser upload finished, waiting for server processing...');
      };

      // Handle streaming response for SSE events (50-100%)
      xhr.onprogress = () => {
        if (!uploadComplete) return;

        const newData = xhr.responseText.substring(receivedLength);
        receivedLength = xhr.responseText.length;
        buffer += newData;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              handleSSEEvent(event);
              if (event.type === 'error') {
                lastError = event.message;
              }
            } catch (e) { /* ignore parse errors */ }
          }
        }
      };

      xhr.onload = () => {
        // Process any remaining buffer
        if (buffer.startsWith('data: ')) {
          try {
            const event = JSON.parse(buffer.slice(6));
            handleSSEEvent(event);
            if (event.type === 'error') {
              lastError = event.message;
            }
          } catch (e) { /* ignore */ }
        }

        if (lastError) {
          reject(new Error(lastError));
        } else if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error('Upload failed'));
        }
      };

      xhr.onerror = () => reject(new Error('Network error'));
      xhr.upload.onerror = () => reject(new Error('Upload failed'));

      xhr.onabort = () => {
        if (currentUpload.cancelled) {
          reject(new Error('Upload cancelled'));
        } else {
          reject(new Error('Upload aborted'));
        }
      };

      xhr.open('POST', API_BASE + '/files');
      xhr.setRequestHeader('Accept', 'text/event-stream');
      xhr.send(formData);
    });

    showToast('File uploaded successfully!');

    // Reset form
    fileInput.value = '';
    fileName.textContent = 'No file selected';

    // Reload files
    await loadFiles();
  } catch (error) {
    if (currentUpload.cancelled) {
      showToast('Upload cancelled', 'error');
    } else {
      showToast(error.message, 'error');
    }
  } finally {
    cancelBtn.hidden = true;
    currentUpload = { xhr: null, fileId: null, cancelled: false };
    setTimeout(() => {
      uploadProgress.hidden = true;
      uploadBtn.disabled = true;
      fileInput.disabled = false;
    }, 1500);
  }
}

// Format ETA milliseconds to human readable
function formatEta(ms) {
  if (ms <= 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  const remainingSecs = seconds % 60;
  return minutes + 'm ' + remainingSecs + 's';
}

// Handle SSE events for Discord upload progress
function handleSSEEvent(event) {
  console.log('[Upload SSE]', event);
  if (event.type === 'status') {
    const percentText = typeof event.percent === 'number'
      ? ' (' + event.percent + '%)'
      : '';
    const message = event.message || 'Processing...';
    progressText.textContent = message + percentText;

    // Show cancel button during encryption (even though no fileId yet)
    if (event.stage === 'encrypting' && !currentUpload.cancelled) {
      cancelBtn.hidden = false;
    }
    // Hide cancel button during cancellation cleanup
    if (event.stage === 'cancelling') {
      cancelBtn.hidden = true;
    }
    return;
  }

  if (event.type === 'start') {
    // Store fileId for cancellation and show cancel button
    currentUpload.fileId = event.fileId;
    cancelBtn.hidden = false;

    const eta = event.estimatedMsPerChunk ? formatEta(event.estimatedMsPerChunk * event.totalParts) : '';
    const etaText = eta ? ' | ETA: ~' + eta : '';
    progressText.textContent = 'Sending to Discord... 0/' + event.totalParts + ' parts' + etaText;
  } else if (event.type === 'uploading') {
    const percent = 50 + Math.round(((event.part - 0.5) / event.totalParts) * 50);
    progressFill.style.width = percent + '%';
    const eta = event.etaMs ? ' | ETA: ' + formatEta(event.etaMs) : '';
    progressText.textContent = 'Sending part ' + event.part + '/' + event.totalParts + '...' + eta;
  } else if (event.type === 'progress') {
    const percent = 50 + Math.round((event.part / event.totalParts) * 50);
    progressFill.style.width = percent + '%';
    const eta = event.etaMs > 0 ? ' | ETA: ' + formatEta(event.etaMs) : '';
    progressText.textContent = 'Sent ' + event.part + '/' + event.totalParts + ' (' + percent + '%)' + eta;
  } else if (event.type === 'complete') {
    cancelBtn.hidden = true;
    progressFill.style.width = '100%';
    progressText.textContent = 'Complete!';
  } else if (event.type === 'error' && event.cancelled) {
    cancelBtn.hidden = true;
    progressText.textContent = 'Cancelled - cleaning up...';
  }
}

// Cancel active upload
async function cancelUpload() {
  if (!currentUpload.xhr && !currentUpload.fileId) {
    return;
  }

  currentUpload.cancelled = true;
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Cancelling...';
  progressText.textContent = 'Cancelling upload...';

  // If we have a fileId, notify backend to cancel (and cleanup sent parts)
  if (currentUpload.fileId) {
    try {
      await fetch(API_BASE + '/files/' + currentUpload.fileId + '/cancel', {
        method: 'POST',
      });
      console.log('[Upload] Cancel request sent for fileId:', currentUpload.fileId);
    } catch (err) {
      console.error('[Upload] Failed to send cancel request:', err);
    }
  }

  // Abort the XHR request
  if (currentUpload.xhr) {
    currentUpload.xhr.abort();
  }

  // Reset button state
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel';
}

// Delete file
async function deleteFile(id) {
  if (!confirm('Are you sure you want to delete this file?')) {
    return;
  }
  
  try {
    const response = await fetch(API_BASE + '/files/' + id, { method: 'DELETE' });
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error);
    }
    
    showToast('File deleted');
    await loadFiles();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Event listeners
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    fileName.textContent = fileInput.files[0].name;
    uploadBtn.disabled = false;
  } else {
    fileName.textContent = 'No file selected';
    uploadBtn.disabled = true;
  }
});

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (fileInput.files.length > 0) {
    await uploadFile(fileInput.files[0]);
  }
});

cancelBtn.addEventListener('click', cancelUpload);

// Initial load
loadFiles();
