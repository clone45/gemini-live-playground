/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// LOCAL PATCH: upstream reads `inputs[0][0]`, the first channel only. On a
// multi-channel interface carrying a mono source (a Focusrite reporting
// "Analogue 1 + 2", say) the voice can sit entirely on the second channel, so
// channel 0 is silence and nothing audible ever reaches the model. `toMono`
// below folds every channel together, taking the largest magnitude at each
// sample rather than averaging, so a signal present on one channel keeps its
// full level instead of losing 6 dB.

const AudioRecordingWorklet = `
class AudioProcessingWorklet extends AudioWorkletProcessor {

  // send and clear buffer every 2048 samples,
  // which at 16khz is about 8 times a second
  buffer = new Int16Array(2048);

  // current write index
  bufferWriteIndex = 0;

  constructor() {
    super();
    this.hasAudio = false;
    this.mono = null;
  }

  /**
   * @param inputs Float32Array[][] [input#][channel#][sample#] so to access first inputs 1st channel inputs[0][0]
   * @param outputs Float32Array[][]
   */
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      this.processChunk(this.toMono(input));
    }
    return true;
  }

  // LOCAL PATCH: fold all channels into one, preserving level.
  toMono(channels) {
    if (channels.length === 1) return channels[0];
    const length = channels[0].length;
    if (!this.mono || this.mono.length !== length) {
      this.mono = new Float32Array(length);
    }
    for (let i = 0; i < length; i++) {
      let loudest = 0;
      let magnitude = -1;
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c][i];
        const a = v < 0 ? -v : v;
        if (a > magnitude) {
          magnitude = a;
          loudest = v;
        }
      }
      this.mono[i] = loudest;
    }
    return this.mono;
  }

  sendAndClearBuffer(){
    this.port.postMessage({
      event: "chunk",
      data: {
        int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer,
      },
    });
    this.bufferWriteIndex = 0;
  }

  processChunk(float32Array) {
    const l = float32Array.length;

    for (let i = 0; i < l; i++) {
      // convert float32 -1 to 1 to int16 -32768 to 32767
      const int16Value = float32Array[i] * 32768;
      this.buffer[this.bufferWriteIndex++] = int16Value;
      if(this.bufferWriteIndex >= this.buffer.length) {
        this.sendAndClearBuffer();
      }
    }

    if(this.bufferWriteIndex >= this.buffer.length) {
      this.sendAndClearBuffer();
    }
  }
}
`;

export default AudioRecordingWorklet;
