export class ScreenCapturer {
  private process: Deno.ChildProcess | null = null;
  private worker: Worker | null = null;
  private frameData: Uint8Array | null = null;
  private frameCount = 0;
  private totalReceiveTime = 0;

  async start() {
    // Start the frame receiver worker first
    console.log("Starting frame receiver worker...");
    this.worker = new Worker(new URL("./frame_receiver_worker.ts", import.meta.url).href, {
      type: "module",
      deno: {
        permissions: {
          net: true,
        },
      },
    });

    // Wait for worker to be ready
    await new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error("Worker not initialized"));

      this.worker.onmessage = (e: MessageEvent) => {
        const { type, data, receiveTime, error } = e.data;
        if (type === 'listening') {
          console.log("TCP server started on worker");
          resolve();
        } else if (type === 'connected') {
          console.log("Client connected to worker");
        } else if (type === 'frame') {
          this.frameData = data;
          this.frameCount++;
          this.totalReceiveTime += receiveTime;
          if (this.frameCount % 30 === 0) {
            const avgReceiveTime = this.totalReceiveTime / this.frameCount;
            console.log(`Average frame receive time: ${avgReceiveTime.toFixed(1)}ms`);
          }
        } else if (type === 'error') {
          console.error('Worker error:', error);
          reject(new Error(error));
        }
      };

      // Tell worker to start TCP server
      this.worker.postMessage({ type: 'connect', port: 12345 });
    });

    // Start the Rust process after worker is ready
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
  }

  getLatestFrame(): Uint8Array | null {
    return this.frameData;
  }

  async stop() {
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' });
      this.worker.terminate();
      this.worker = null;
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
