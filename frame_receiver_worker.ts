// Frame receiver worker
let conn: Deno.Conn | null = null;
let listener: Deno.Listener | null = null;
let isConnected = false;

const worker = self as unknown as Worker;

async function readExactly(size: number): Promise<Uint8Array | null> {
  if (!conn) return null;
  const buffer = new Uint8Array(size);
  let totalRead = 0;
  try {
    while (totalRead < size) {
      const bytesRead = await conn.read(buffer.subarray(totalRead));
      if (!bytesRead) {
        console.log("Connection closed while reading");
        return null;
      }
      totalRead += bytesRead;
    }
    return buffer;
  } catch (err) {
    console.error("Error reading from connection:", err);
    return null;
  }
}

async function receiveFrame(): Promise<Uint8Array | null> {
  const METADATA_SIZE = 8; // 4 bytes for total size + 4 bytes for chunk count
  try {
    // Read metadata
    const metadataBuffer = await readExactly(METADATA_SIZE);
    if (!metadataBuffer) return null;

    // Parse metadata
    const totalSize = new DataView(metadataBuffer.buffer).getUint32(0, true);
    const numChunks = new DataView(metadataBuffer.buffer).getUint32(4, true);

    // Create buffer for the entire frame
    const frameData = new Uint8Array(totalSize);
    let totalReceived = 0;

    // Read all chunks
    for (let i = 0; i < numChunks; i++) {
      // Read chunk size
      const sizeBuffer = await readExactly(4);
      if (!sizeBuffer) return null;
      const chunkSize = new DataView(sizeBuffer.buffer).getUint32(0, true);

      // Read chunk data
      const chunkData = await readExactly(chunkSize);
      if (!chunkData) return null;

      frameData.set(chunkData, totalReceived);
      totalReceived += chunkSize;
    }

    return frameData;
  } catch (error) {
    console.error("Frame receive error:", error);
    return null;
  }
}

async function startReceiving() {
  while (isConnected) {
    const frameStart = performance.now();
    const frame = await receiveFrame();
    if (frame) {
      const receiveTime = performance.now() - frameStart;
      worker.postMessage({ type: 'frame', data: frame, receiveTime });
    }
    // Small delay to prevent tight loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

worker.onmessage = async (e: MessageEvent) => {
  const { type, port } = e.data;
  
  if (type === 'connect') {
    try {
      // Create TCP server
      listener = Deno.listen({
        hostname: "127.0.0.1",
        port,
      });
      worker.postMessage({ type: 'listening', port });

      // Wait for client connection
      console.log("Waiting for client connection...");
      conn = await listener.accept();
      isConnected = true;
      worker.postMessage({ type: 'connected' });
      startReceiving();
    } catch (err) {
      worker.postMessage({ type: 'error', error: err.message });
    }
  } else if (type === 'stop') {
    isConnected = false;
    if (conn) {
      conn.close();
      conn = null;
    }
    if (listener) {
      listener.close();
      listener = null;
    }
    worker.postMessage({ type: 'stopped' });
  }
};
