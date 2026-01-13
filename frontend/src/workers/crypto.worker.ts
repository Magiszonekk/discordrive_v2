// Web Worker for client-side encryption
// This worker handles AES-GCM encryption off the main thread

interface InitMessage {
  type: "init";
  password: string;
  salt: Uint8Array;
  ivLength: number;
  pbkdf2Iterations: number;
}

interface EncryptMessage {
  type: "encrypt";
  id: number;
  data: ArrayBuffer;
}

interface TerminateMessage {
  type: "terminate";
}

type WorkerMessage = InitMessage | EncryptMessage | TerminateMessage;

interface InitResponse {
  type: "init";
  success: boolean;
  error?: string;
}

interface EncryptResponse {
  type: "encrypt";
  id: number;
  cipher: ArrayBuffer;
  iv: Uint8Array;
  tag: Uint8Array;
  plainSize: number;
}

interface ErrorResponse {
  type: "error";
  id?: number;
  error: string;
}

let derivedKey: CryptoKey | null = null;
let ivLength = 12;
let pbkdf2Iterations = 100_000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new Uint8Array(salt),
      iterations: pbkdf2Iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
}

async function encryptChunk(
  data: ArrayBuffer,
  key: CryptoKey,
  ivLen: number
): Promise<{ cipher: ArrayBuffer; iv: Uint8Array; tag: Uint8Array }> {
  const iv = new Uint8Array(ivLen);
  crypto.getRandomValues(iv);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    data
  );

  const cipherArray = new Uint8Array(encrypted);
  const tagLength = 16;
  const tag = cipherArray.slice(cipherArray.length - tagLength);

  return { cipher: encrypted, iv, tag };
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "init": {
        const saltArray = msg.salt instanceof Uint8Array
          ? msg.salt
          : new Uint8Array(msg.salt);
        pbkdf2Iterations = msg.pbkdf2Iterations || 100_000;
        derivedKey = await deriveKey(msg.password, saltArray);
        ivLength = msg.ivLength || 12;
        const response: InitResponse = { type: "init", success: true };
        self.postMessage(response);
        break;
      }

      case "encrypt": {
        if (!derivedKey) {
          const errorResponse: ErrorResponse = {
            type: "error",
            id: msg.id,
            error: "Worker not initialized - call init first",
          };
          self.postMessage(errorResponse);
          return;
        }

        const { cipher, iv, tag } = await encryptChunk(msg.data, derivedKey, ivLength);
        const response: EncryptResponse = {
          type: "encrypt",
          id: msg.id,
          cipher,
          iv,
          tag,
          plainSize: msg.data.byteLength,
        };
        // Transfer the cipher buffer to avoid copying
        (self as unknown as Worker).postMessage(response, [cipher]);
        break;
      }

      case "terminate": {
        derivedKey = null;
        self.close();
        break;
      }
    }
  } catch (error) {
    const errorResponse: ErrorResponse = {
      type: "error",
      id: (msg as EncryptMessage).id,
      error: error instanceof Error ? error.message : "Unknown error",
    };
    self.postMessage(errorResponse);
  }
};

// Ensure this worker is treated as a module to avoid polluting the global scope
export {};
