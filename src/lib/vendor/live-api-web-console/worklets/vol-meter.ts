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

// LOCAL PATCH: upstream measures `input[0]` only, so the meter reads silence on
// a multi-channel device whose signal sits on a later channel. It now takes the
// loudest channel, matching the recording worklet.

const VolMeterWorket = `
  class VolMeter extends AudioWorkletProcessor {
    volume
    updateIntervalInMS
    nextUpdateFrame

    constructor() {
      super()
      this.volume = 0
      this.updateIntervalInMS = 25
      this.nextUpdateFrame = this.updateIntervalInMS
      this.port.onmessage = event => {
        if (event.data.updateIntervalInMS) {
          this.updateIntervalInMS = event.data.updateIntervalInMS
        }
      }
    }

    get intervalInFrames() {
      return (this.updateIntervalInMS / 1000) * sampleRate
    }

    process(inputs) {
      const input = inputs[0]

      if (input.length > 0) {
        // LOCAL PATCH: loudest channel rather than channel 0.
        let rms = 0
        for (let c = 0; c < input.length; c++) {
          const samples = input[c]
          let sum = 0
          for (let i = 0; i < samples.length; ++i) {
            sum += samples[i] * samples[i]
          }
          const channelRms = Math.sqrt(sum / samples.length)
          if (channelRms > rms) rms = channelRms
        }

        this.volume = Math.max(rms, this.volume * 0.7)

        this.nextUpdateFrame -= input[0].length
        if (this.nextUpdateFrame < 0) {
          this.nextUpdateFrame += this.intervalInFrames
          this.port.postMessage({volume: this.volume})
        }
      }

      return true
    }
  }`;

export default VolMeterWorket;
