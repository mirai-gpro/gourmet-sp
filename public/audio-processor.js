/**
 * AudioWorklet Processor for Real-time PCM Extraction
 *
 * Float32Array → Int16Array 変換を行い、リアルタイムで音声チャンクを送信
 * iPhone最適化版
 */

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ★★★ バッファサイズを小さく（遅延を最小化） ★★★
    this.bufferSize = 2048; // 4096 → 2048に変更（約0.128秒）
    // ★★★ Int16Arrayで直接管理（高速化） ★★★
    this.buffer = new Int16Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];

    if (input.length > 0) {
      const channelData = input[0]; // モノラル (チャンネル0のみ)

      // Float32Array を Int16Array に変換
      for (let i = 0; i < channelData.length; i++) {
        // Float32 (-1.0 ~ 1.0) を Int16 (-32768 ~ 32767) に変換
        const s = Math.max(-1, Math.min(1, channelData[i]));
        const int16Value = s < 0 ? s * 0x8000 : s * 0x7FFF;
        
        // ★★★ バッファに直接書き込み（高速） ★★★
        this.buffer[this.bufferIndex++] = int16Value;

        // バッファサイズに達したらメインスレッドに送信
        if (this.bufferIndex >= this.bufferSize) {
          // ★★★ コピーして送信 ★★★
          const chunk = new Int16Array(this.buffer);
          this.port.postMessage({ audioChunk: chunk });
          
          // バッファをリセット
          this.bufferIndex = 0;
        }
      }
    }

    return true; // プロセッサーを継続
  }
}

registerProcessor('audio-processor', AudioProcessor);
