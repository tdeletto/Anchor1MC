/**
 * Pulls microphone audio off the realtime thread in ~64 ms blocks.
 *
 * AudioWorklet runs every 128 frames, which is far too chatty to post across
 * threads, so blocks are accumulated before being handed over.
 */
const BLOCK = 1024;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BLOCK);
    this.offset = 0;
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.offset] = channel[i];
      this.offset += 1;
      if (this.offset === BLOCK) {
        // Transfer a copy; the buffer keeps filling immediately.
        const block = this.buffer.slice();
        this.port.postMessage(block, [block.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('anchor1mc-recorder', RecorderProcessor);
