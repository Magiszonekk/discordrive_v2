/**
 * Worker Pool - manages a pool of crypto workers for CPU-intensive operations
 *
 * Features:
 * - Pre-spawned workers based on CPU cores
 * - Task queue with automatic worker assignment
 * - Worker health monitoring and restart on failure
 * - Graceful shutdown support
 */

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

const WORKER_PATH = path.join(__dirname, '../workers/crypto-worker.js');

class WorkerPool {
  constructor(options = {}) {
    this.size = options.size || Math.max(2, Math.min(os.cpus().length - 1, 4));
    this.workers = [];
    this.availableWorkers = [];
    this.taskQueue = [];
    this.taskIdCounter = 0;
    this.pendingTasks = new Map(); // taskId -> { resolve, reject }
    this.isShuttingDown = false;
    this.initialized = false;
  }

  /**
   * Initialize the worker pool
   */
  async initialize() {
    if (this.initialized) return;

    const workerPromises = [];
    for (let i = 0; i < this.size; i++) {
      workerPromises.push(this._spawnWorker(i));
    }

    await Promise.all(workerPromises);
    this.initialized = true;
    console.log(`[WorkerPool] Initialized with ${this.size} workers`);
  }

  /**
   * Spawn a single worker
   */
  async _spawnWorker(index) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH);

      worker.on('message', (message) => {
        if (message.type === 'ready') {
          this.workers[index] = worker;
          this.availableWorkers.push(worker);
          resolve(worker);
          return;
        }

        // Handle task response
        const { id, success, result, error } = message;
        const pending = this.pendingTasks.get(id);
        if (pending) {
          this.pendingTasks.delete(id);
          if (success) {
            pending.resolve(result);
          } else {
            pending.reject(new Error(error));
          }

          // Mark worker as available and process next task
          this.availableWorkers.push(worker);
          this._processQueue();
        }
      });

      worker.on('error', (error) => {
        console.error(`[WorkerPool] Worker ${index} error:`, error.message);
        this._handleWorkerError(worker, index);
      });

      worker.on('exit', (code) => {
        if (code !== 0 && !this.isShuttingDown) {
          console.warn(`[WorkerPool] Worker ${index} exited with code ${code}, restarting...`);
          this._restartWorker(index);
        }
      });

      // Timeout for worker initialization
      setTimeout(() => {
        if (!this.workers[index]) {
          reject(new Error(`Worker ${index} failed to initialize within timeout`));
        }
      }, 5000);
    });
  }

  /**
   * Handle worker error
   */
  _handleWorkerError(worker, index) {
    // Remove from available workers
    const availableIndex = this.availableWorkers.indexOf(worker);
    if (availableIndex !== -1) {
      this.availableWorkers.splice(availableIndex, 1);
    }

    // Restart worker
    if (!this.isShuttingDown) {
      this._restartWorker(index);
    }
  }

  /**
   * Restart a worker
   */
  async _restartWorker(index) {
    try {
      await this._spawnWorker(index);
      console.log(`[WorkerPool] Worker ${index} restarted successfully`);
    } catch (error) {
      console.error(`[WorkerPool] Failed to restart worker ${index}:`, error.message);
    }
  }

  /**
   * Execute a task on a worker
   */
  async execute(operation, data) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.isShuttingDown) {
      throw new Error('Worker pool is shutting down');
    }

    return new Promise((resolve, reject) => {
      const taskId = ++this.taskIdCounter;
      const task = { id: taskId, operation, data, resolve, reject };

      this.pendingTasks.set(taskId, { resolve, reject });
      this.taskQueue.push(task);
      this._processQueue();
    });
  }

  /**
   * Process the task queue
   */
  _processQueue() {
    while (this.taskQueue.length > 0 && this.availableWorkers.length > 0) {
      const worker = this.availableWorkers.shift();
      const task = this.taskQueue.shift();

      worker.postMessage({
        id: task.id,
        operation: task.operation,
        data: task.data,
      });
    }
  }

  /**
   * Derive key using worker (async, non-blocking)
   */
  async deriveKey(password, salt, iterations = 100000) {
    const result = await this.execute('deriveKey', {
      password: Buffer.isBuffer(password) ? password.toString() : password,
      salt: Buffer.isBuffer(salt) ? salt.toString('base64') : salt,
      iterations,
    });
    return Buffer.from(result.key, 'base64');
  }

  /**
   * Encrypt chunk using worker
   */
  async encryptChunk(chunk, key) {
    const result = await this.execute('encryptChunk', {
      chunk: Buffer.isBuffer(chunk) ? chunk.toString('base64') : chunk,
      key: Buffer.isBuffer(key) ? key.toString('base64') : key,
    });
    return {
      iv: Buffer.from(result.iv, 'base64'),
      authTag: Buffer.from(result.authTag, 'base64'),
      encrypted: Buffer.from(result.encrypted, 'base64'),
    };
  }

  /**
   * Decrypt chunk using worker
   */
  async decryptChunk(encrypted, key, iv, authTag) {
    const result = await this.execute('decryptChunk', {
      encrypted: Buffer.isBuffer(encrypted) ? encrypted.toString('base64') : encrypted,
      key: Buffer.isBuffer(key) ? key.toString('base64') : key,
      iv: Buffer.isBuffer(iv) ? iv.toString('base64') : iv,
      authTag: Buffer.isBuffer(authTag) ? authTag.toString('base64') : authTag,
    });
    return Buffer.from(result.decrypted, 'base64');
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      totalWorkers: this.size,
      availableWorkers: this.availableWorkers.length,
      pendingTasks: this.pendingTasks.size,
      queuedTasks: this.taskQueue.length,
    };
  }

  /**
   * Gracefully shutdown all workers
   */
  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('[WorkerPool] Shutting down...');

    // Reject pending tasks
    for (const [taskId, { reject }] of this.pendingTasks) {
      reject(new Error('Worker pool shutdown'));
    }
    this.pendingTasks.clear();
    this.taskQueue = [];

    // Terminate workers
    const terminatePromises = this.workers.map((worker) => {
      if (worker) {
        return worker.terminate();
      }
      return Promise.resolve();
    });

    await Promise.all(terminatePromises);
    this.workers = [];
    this.availableWorkers = [];

    console.log('[WorkerPool] Shutdown complete');
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the worker pool instance
 */
function getWorkerPool(options) {
  if (!instance) {
    instance = new WorkerPool(options);
  }
  return instance;
}

/**
 * Shutdown the worker pool
 */
async function shutdownWorkerPool() {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}

module.exports = {
  WorkerPool,
  getWorkerPool,
  shutdownWorkerPool,
};
