export class ScreenCapturer {
  private process: Deno.ChildProcess | null = null;
  private listener: Deno.Listener | null = null;
  private conn: Deno.Conn | null = null;
  private frameData: Uint8Array | null = null;
  private isConnected = false;

  async start() {
    // Start TCP server first
    this.listener = Deno.listen({
      hostname: "127.0.0.1",
      port: 12345,
    });
    console.log("TCP server started on 127.0.0.1:12345");

    // Start the Rust process
    const command = new Deno.Command("./screen-streamer", {
      cwd: Deno.cwd(),
      stdout: "piped",
      stderr: "piped",
    });

    this.process = command.spawn();
    
    // Log any stderr output for debugging
    this.process.stderr.pipeTo(new WritableStream({
      write(chunk) {
        console.error(new TextDecoder().decode(chunk));
      }
    }));

    // Log stdout for debugging
    const textDecoder = new TextDecoder();
    this.process.stdout.pipeTo(new WritableStream({
      write(chunk) {
        console.log(textDecoder.decode(chunk));
      }
    }));

    // Wait for client connection
    console.log("Waiting for screen capture client to connect...");
    try {
      this.conn = await this.listener.accept();
      this.isConnected = true;
      console.log("Screen capture client connected");
      this.startFrameReceiver();
    } catch (err) {
      console.error("Failed to accept connection:", err);
      await this.stop();
      throw err;
    }
  }

  private async startFrameReceiver() {
    console.log("Starting frame receiver...");
    while (this.isConnected) {
      try {
        const frame = await this.receiveFrame();
        if (frame) {
          //console.log("✅ Successfully received frame");
          this.frameData = frame;
        } else {
          console.log("❌ No frame received");
          // Add small delay when no frame is received
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      } catch (err) {
        console.error("Error receiving frame:", err);
        this.isConnected = false;
        break;
      }
      // Add small delay between frame receives
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    console.log("Frame receiver stopped");
  }

  private async readExactly(size: number): Promise<Uint8Array | null> {
    if (!this.conn) return null;
    const buffer = new Uint8Array(size);
    let totalRead = 0;

    try {
      while (totalRead < size) {
        const bytesRead = await this.conn.read(buffer.subarray(totalRead));
        if (!bytesRead) {
          console.log("Connection closed while reading");
          return null; // Connection closed
        }
        totalRead += bytesRead;
        // Add small delay in read loop
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      return buffer;
    } catch (err) {
      console.error("Error reading from connection:", err);
      return null;
    }
  }

  private async receiveFrame(): Promise<Uint8Array | null> {
    const CHUNK_SIZE = 256 * 1024; // 256KB chunks
    const METADATA_SIZE = 8; // 4 bytes for total size + 4 bytes for chunk count

    try {
      // Read metadata
      const metadataBuffer = await this.readExactly(METADATA_SIZE);
      if (!metadataBuffer) {
        console.log("No metadata received");
        return null;
      }

      // Parse metadata
      const totalSize = new DataView(metadataBuffer.buffer).getUint32(0, true);
      const numChunks = new DataView(metadataBuffer.buffer).getUint32(4, true);
      //console.log(`Receiving frame: ${totalSize} bytes in ${numChunks} chunks`);

      // Create buffer for the entire frame
      const frameData = new Uint8Array(totalSize);
      let totalReceived = 0;

      // Read all chunks
      for (let i = 0; i < numChunks; i++) {
        // Read chunk size
        const sizeBuffer = await this.readExactly(4);
        if (!sizeBuffer) {
          console.log("Failed to read chunk size");
          return null;
        }
        const chunkSize = new DataView(sizeBuffer.buffer).getUint32(0, true);
        //console.log(`Reading chunk ${i + 1}/${numChunks}: ${chunkSize} bytes`);

        // Read chunk data
        const chunkData = await this.readExactly(chunkSize);
        if (!chunkData) {
          console.log("Failed to read chunk data");
          return null;
        }

        frameData.set(chunkData, totalReceived);
        totalReceived += chunkSize;
        
        // Add small delay between chunks
        await new Promise(resolve => setTimeout(resolve, 1));
      }

      //console.log(`Frame complete: ${totalReceived}/${totalSize} bytes received`);
      return frameData;
    } catch (error) {
      console.error("Frame receive error:", error);
      return null;
    }
  }

  getLatestFrame(): Uint8Array | null {
    return this.frameData;
  }

  async stop() {
    this.isConnected = false;
    if (this.conn) {
      try {
        this.conn.close();
      } catch (err) {
        console.error("Error closing connection:", err);
      }
      this.conn = null;
    }

    if (this.listener) {
      try {
        this.listener.close();
      } catch (err) {
        console.error("Error closing listener:", err);
      }
      this.listener = null;
    }
    
    if (this.process) {
      try {
        this.process.kill();
        const status = await this.process.status;
        console.log("Process exited with status:", status.code);
      } catch (err) {
        console.error("Error killing process:", err);
      }
      this.process = null;
    }
  }
}
