// src/scripts/chat/audio-manager.ts

export class AudioManager {
  private audioContext: AudioContext | null = null;
  private globalAudioContext: AudioContext | null = null; // iOS用
  private audioWorkletNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private ttsPlayer: HTMLAudioElement;
  
  // レガシー録音用
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];

  // 状態管理
  private vadCheckInterval: number | null = null;
  private silenceTimer: number | null = null;
  private hasSpoken = false;
  private recordingStartTime = 0;
  private recordingTimer: number | null = null;
  
  // 定数
  private readonly SILENCE_THRESHOLD = 35;
  private readonly SILENCE_DURATION = 2000;
  private readonly MIN_RECORDING_TIME = 3000;
  private readonly MAX_RECORDING_TIME = 55000;

  private isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  constructor() {
    this.ttsPlayer = new Audio();
  }

  // ユーザー操作時に呼ぶ（ロック解除）
  public unlockAudioContext() {
    if (this.globalAudioContext && this.globalAudioContext.state === 'suspended') {
      this.globalAudioContext.resume();
    }
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    // iOSでの再生トリガー確保
    this.ttsPlayer.play().then(() => {
      this.ttsPlayer.pause();
      this.ttsPlayer.currentTime = 0;
    }).catch(() => {});
  }

  // ★復活: 完全リセット機能（Android等の不具合復帰用）
  public fullResetAudioResources() {
    this.stopStreaming(); // 既存の停止処理
    
    // さらに念入りに破棄
    if (this.globalAudioContext && this.globalAudioContext.state !== 'closed') {
      this.globalAudioContext.close();
      this.globalAudioContext = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.mediaStream = null;
  }

  public async startStreaming(
    socket: any, 
    languageCode: string, 
    onStopCallback: () => void,
    onSpeechStart?: () => void // ★追加: 発話検知時のUI更新用
  ) {
    if (this.isIOS) {
      await this.startStreaming_iOS(socket, languageCode, onStopCallback); // iOSはVAD未実装（オリジナル通り）
    } else {
      await this.startStreaming_Default(socket, languageCode, onStopCallback, onSpeechStart);
    }
  }

  public stopStreaming() {
    if (this.isIOS) {
      this.stopStreaming_iOS();
    } else {
      this.stopStreaming_Default();
    }
    // レガシー録音も停止
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;
  }

  // =================================================================
  // ★復活: レガシー録音 (MediaRecorder)
  // Socketがつながらない場合やフォールバック用
  // =================================================================
  public async startLegacyRecording(
    onStopCallback: (audioBlob: Blob) => void,
    onSpeechStart?: () => void
  ) {
    try {
      if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }

      // ストリーム取得
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          channelCount: 1, 
          sampleRate: 16000, 
          echoCancellation: true, 
          noiseSuppression: true 
        } 
      });
      this.mediaStream = stream;

      // MediaRecorder設定
      // @ts-ignore
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      this.audioChunks = [];
      this.hasSpoken = false;
      this.recordingStartTime = Date.now();

      // VAD用 (AudioContext併用)
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      // VADループ
      this.vadCheckInterval = window.setInterval(() => {
        if (!this.analyser) return;
        if (Date.now() - this.recordingStartTime < this.MIN_RECORDING_TIME) return;
        
        this.analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        
        if (average > this.SILENCE_THRESHOLD) { 
           this.hasSpoken = true; 
           if (this.silenceTimer) clearTimeout(this.silenceTimer);
           if (onSpeechStart) onSpeechStart(); // UI更新通知
        } else if (this.hasSpoken && !this.silenceTimer) { 
           // 沈黙検知 -> 停止
           this.silenceTimer = window.setTimeout(() => { 
             if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.stop();
             }
           }, this.SILENCE_DURATION); 
        }
      }, 100);

      this.mediaRecorder.ondataavailable = (event) => { 
        if (event.data.size > 0) this.audioChunks.push(event.data); 
      };

      this.mediaRecorder.onstop = async () => {
        this.stopVAD_Default();
        stream.getTracks().forEach(track => track.stop());
        if (this.recordingTimer) clearTimeout(this.recordingTimer);
        
        if (this.audioChunks.length > 0) {
           const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
           onStopCallback(audioBlob);
        }
      };

      this.mediaRecorder.start();

      // 最大録音時間タイマー
      this.recordingTimer = window.setTimeout(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
        }
      }, this.MAX_RECORDING_TIME);

    } catch (error) {
      console.error('Legacy recording error:', error);
      throw error;
    }
  }

  // =================================================================
  // PC / Android 用の実装 (Default)
  // =================================================================
  private async startStreaming_Default(
    socket: any, 
    languageCode: string, 
    onStopCallback: () => void,
    onSpeechStart?: () => void
  ) {
    try {
      if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }
      
      // Worklet cleanup
      if (this.audioWorkletNode) { 
        this.audioWorkletNode.port.onmessage = null; 
        this.audioWorkletNode.disconnect(); 
        this.audioWorkletNode = null; 
      }
      
      if (!this.audioContext) {
        // @ts-ignore
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioContextClass({ latencyHint: 'playback' });
      }
      
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      if (this.mediaStream) { 
        this.mediaStream.getTracks().forEach(track => track.stop()); 
        this.mediaStream = null; 
      }
      
      const audioConstraints = { 
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true 
      };
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      
      const targetSampleRate = 16000;
      const nativeSampleRate = this.audioContext.sampleRate;
      const downsampleRatio = nativeSampleRate / targetSampleRate;
      
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      const audioProcessorCode = `
      class AudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.bufferSize = 16000;
          this.buffer = new Int16Array(this.bufferSize); 
          this.writeIndex = 0;
          this.ratio = ${downsampleRatio}; 
          this.inputSampleCount = 0;
          this.flushThreshold = 8000;
        }
        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (!input || input.length === 0) return true;
          const channelData = input[0];
          if (!channelData || channelData.length === 0) return true;
          for (let i = 0; i < channelData.length; i++) {
            this.inputSampleCount++;
            if (this.inputSampleCount >= this.ratio) {
              this.inputSampleCount -= this.ratio;
              if (this.writeIndex < this.bufferSize) {
                const s = Math.max(-1, Math.min(1, channelData[i]));
                const int16Value = s < 0 ? s * 0x8000 : s * 0x7FFF;
                this.buffer[this.writeIndex++] = int16Value;
              }
              if (this.writeIndex >= this.bufferSize) {
                this.flush();
              }
            }
          }
          return true;
        }
        flush() {
          if (this.writeIndex === 0) return;
          const chunk = this.buffer.slice(0, this.writeIndex);
          this.port.postMessage({ audioChunk: chunk }, [chunk.buffer]);
          this.writeIndex = 0;
        }
      }
      registerProcessor('audio-processor', AudioProcessor);
      `;

      try {
        const blob = new Blob([audioProcessorCode], { type: 'application/javascript' });
        const processorUrl = URL.createObjectURL(blob);
        await this.audioContext.audioWorklet.addModule(processorUrl);
        URL.revokeObjectURL(processorUrl);
      } catch (workletError) {
        throw new Error(`音声処理初期化エラー: ${(workletError as Error).message}`);
      }
      
      this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-processor');
      this.audioWorkletNode.port.onmessage = (event) => {
        const { audioChunk } = event.data;
        if (socket && socket.connected) {
          try {
            const blob = new Blob([audioChunk], { type: 'application/octet-stream' });
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result as string;
                const base64 = result.split(',')[1];
                socket.emit('audio_chunk', { chunk: base64, sample_rate: 16000 });
            };
            reader.readAsDataURL(blob);
          } catch (e) {
            console.error('Audio convert error', e);
          }
        }
      };
      
      source.connect(this.audioWorkletNode);
      this.audioWorkletNode.connect(this.audioContext.destination);

      // VAD Setup
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.hasSpoken = false;
      this.recordingStartTime = Date.now();
      
      this.vadCheckInterval = window.setInterval(() => {
        if (!this.analyser) return;
        if (Date.now() - this.recordingStartTime < this.MIN_RECORDING_TIME) return;
        this.analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        
        if (average > this.SILENCE_THRESHOLD) { 
           this.hasSpoken = true; 
           if (this.silenceTimer) clearTimeout(this.silenceTimer);
           if (onSpeechStart) onSpeechStart(); // ★UI通知
        } else if (this.hasSpoken && !this.silenceTimer) { 
           this.silenceTimer = window.setTimeout(() => { 
             this.stopStreaming_Default();
             onStopCallback();
           }, this.SILENCE_DURATION); 
        }
      }, 100);

      if (socket && socket.connected) {
        socket.emit('stop_stream');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      socket.emit('start_stream', { 
        language_code: languageCode,
        sample_rate: 16000
      });

      this.recordingTimer = window.setTimeout(() => { 
        this.stopStreaming_Default();
        onStopCallback();
      }, this.MAX_RECORDING_TIME);

    } catch (error) {
      if (this.mediaStream) { this.mediaStream.getTracks().forEach(track => track.stop()); this.mediaStream = null; }
      throw error;
    }
  }

  private stopVAD_Default() {
      if (this.vadCheckInterval) { clearInterval(this.vadCheckInterval); this.vadCheckInterval = null; }
      if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
      if (this.analyser) { this.analyser = null; }
      if (this.audioContext && this.audioContext.state !== 'closed') { 
        this.audioContext.close(); 
        this.audioContext = null; 
      }
  }

  private stopStreaming_Default() {
    this.stopVAD_Default();
    if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }
    
    if (this.audioWorkletNode) { 
      this.audioWorkletNode.port.onmessage = null; 
      this.audioWorkletNode.disconnect(); 
      this.audioWorkletNode = null; 
    }
    if (this.mediaStream) { 
      this.mediaStream.getTracks().forEach(track => track.stop()); 
      this.mediaStream = null; 
    }
    this.hasSpoken = false;
  }

  // =================================================================
  // iOS 用の実装 (ほぼオリジナル通りだが型定義など整理)
  // =================================================================
  private async startStreaming_iOS(socket: any, languageCode: string, onStopCallback: () => void) {
    // ... 前回のiOS実装と同じ（省略せずそのまま使用してください） ...
    try {
      if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }
      
      if (this.audioWorkletNode) { 
        this.audioWorkletNode.port.onmessage = null;
        this.audioWorkletNode.disconnect(); 
        this.audioWorkletNode = null; 
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (!this.globalAudioContext) {
        // @ts-ignore
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.globalAudioContext = new AudioContextClass({ 
          latencyHint: 'interactive',
          sampleRate: 48000
        });
      }
      
      if (this.globalAudioContext.state === 'suspended') {
        await this.globalAudioContext.resume();
      }

      if (this.mediaStream) {
        const tracks = this.mediaStream.getAudioTracks();
        if (tracks.length > 0 && tracks[0].readyState === 'live') {
          // reuse
        } else {
          this.mediaStream.getTracks().forEach(track => track.stop());
          this.mediaStream = null;
        }
      }
      
      if (!this.mediaStream) {
        const audioConstraints = { 
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000
        };
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      }
      
      const targetSampleRate = 16000;
      const nativeSampleRate = this.globalAudioContext.sampleRate;
      const downsampleRatio = nativeSampleRate / targetSampleRate;
      
      const source = this.globalAudioContext.createMediaStreamSource(this.mediaStream);
      const processorName = 'audio-processor-ios-' + Date.now(); // ユニーク名

      const audioProcessorCode = `
      class AudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.bufferSize = 4096; // iOS tuning
          this.buffer = new Int16Array(this.bufferSize); 
          this.writeIndex = 0;
          this.ratio = ${downsampleRatio}; 
          this.inputSampleCount = 0;
          this.lastFlushTime = Date.now();
        }
        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (!input || input.length === 0) return true;
          const channelData = input[0];
          for (let i = 0; i < channelData.length; i++) {
            this.inputSampleCount++;
            if (this.inputSampleCount >= this.ratio) {
              this.inputSampleCount -= this.ratio;
              if (this.writeIndex < this.bufferSize) {
                const s = Math.max(-1, Math.min(1, channelData[i]));
                const int16Value = s < 0 ? s * 0x8000 : s * 0x7FFF;
                this.buffer[this.writeIndex++] = int16Value;
              }
              if (this.writeIndex >= this.bufferSize || (this.writeIndex > 0 && Date.now() - this.lastFlushTime > 200)) {
                this.flush();
              }
            }
          }
          return true;
        }
        flush() {
          if (this.writeIndex === 0) return;
          const chunk = this.buffer.slice(0, this.writeIndex);
          this.port.postMessage({ audioChunk: chunk }, [chunk.buffer]);
          this.writeIndex = 0;
          this.lastFlushTime = Date.now();
        }
      }
      registerProcessor('${processorName}', AudioProcessor);
      `;

      const blob = new Blob([audioProcessorCode], { type: 'application/javascript' });
      const processorUrl = URL.createObjectURL(blob);
      await this.globalAudioContext.audioWorklet.addModule(processorUrl);
      URL.revokeObjectURL(processorUrl);
      
      this.audioWorkletNode = new AudioWorkletNode(this.globalAudioContext, processorName);
      this.audioWorkletNode.port.onmessage = (event) => {
        const { audioChunk } = event.data;
        if (socket && socket.connected) {
          try {
            const base64 = this.arrayBufferToBase64(audioChunk.buffer);
            socket.emit('audio_chunk', { chunk: base64, sample_rate: 16000 });
          } catch (e) { }
        }
      };
      
      if (socket && socket.connected) {
        socket.emit('stop_stream');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      socket.emit('start_stream', { 
        language_code: languageCode,
        sample_rate: 16000
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      source.connect(this.audioWorkletNode);
      this.audioWorkletNode.connect(this.globalAudioContext.destination);
      
      this.recordingTimer = window.setTimeout(() => { 
        this.stopStreaming_iOS();
        onStopCallback();
      }, this.MAX_RECORDING_TIME);

    } catch (error) {
      if (this.audioWorkletNode) { 
        this.audioWorkletNode.port.onmessage = null;
        this.audioWorkletNode.disconnect(); 
        this.audioWorkletNode = null; 
      }
      throw error;
    }
  }

  private stopStreaming_iOS() {
    if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }
    if (this.audioWorkletNode) { 
      this.audioWorkletNode.port.onmessage = null;
      this.audioWorkletNode.disconnect(); 
      this.audioWorkletNode = null; 
    }
  }

  // --- 共通ユーティリティ ---

  public async playTTS(audioBase64: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ttsPlayer.src = `data:audio/mp3;base64,${audioBase64}`;
      this.ttsPlayer.onended = () => resolve();
      this.ttsPlayer.onerror = (e) => reject(e);
      this.ttsPlayer.play().catch(reject);
    });
  }

  public stopTTS() {
    this.ttsPlayer.pause();
    this.ttsPlayer.currentTime = 0;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (let i = 0; i < len; i += 3) {
      const c1 = bytes[i];
      const c2 = bytes[i + 1];
      const c3 = bytes[i + 2];
      const enc1 = c1 >> 2;
      const enc2 = ((c1 & 3) << 4) | (c2 >> 4);
      const enc3 = ((c2 & 15) << 2) | (c3 >> 6);
      const enc4 = c3 & 63;
      if (Number.isNaN(c2)) {
        binary += chars[enc1] + chars[enc2] + "==";
      } else if (Number.isNaN(c3)) {
        binary += chars[enc1] + chars[enc2] + chars[enc3] + "=";
      } else {
        binary += chars[enc1] + chars[enc2] + chars[enc3] + chars[enc4];
      }
    }
    return binary;
  }
}