// src/scripts/chat/concierge-controller.ts（修正版・完全版）
import { CoreController } from './core-controller';
import { AudioManager } from './audio-manager';

declare const io: any;

export class ConciergeController extends CoreController {
  
  constructor(container: HTMLElement, apiBase: string) {
    super(container, apiBase);
    
    // コンシェルジュモード用のAudioManagerを8秒設定で再初期化
    this.audioManager = new AudioManager(8000);
    
    // コンシェルジュモードに設定
    this.currentMode = 'concierge';
    this.init();
  }

  // 初期化プロセスをオーバーライド
  protected async init() {
    // 親クラスの初期化を実行
    await super.init();
    
    // コンシェルジュ固有の要素とイベントを追加
    const query = (sel: string) => this.container.querySelector(sel) as HTMLElement;
    this.els.avatarContainer = query('.avatar-container');
    this.els.avatarImage = query('#avatarImage') as HTMLImageElement;
    this.els.modeSwitch = query('#modeSwitch') as HTMLInputElement;
    
    // モードスイッチのイベントリスナー追加
    if (this.els.modeSwitch) {
      this.els.modeSwitch.addEventListener('change', () => {
        this.toggleMode();
      });
    }
  }

  // ========================================
  // 🎯 セッション初期化をオーバーライド(挨拶文を変更)
  // ========================================
  protected async initializeSession() {
    try {
      if (this.sessionId) {
        try {
          await fetch(`${this.apiBase}/api/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: this.sessionId })
          });
        } catch (e) {}
      }

      // ★ user_id を取得（親クラスのメソッドを使用）
      const userId = this.getUserId();

      const res = await fetch(`${this.apiBase}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_info: { user_id: userId },
          language: this.currentLanguage,
          mode: 'concierge'
        })
      });
      const data = await res.json();
      this.sessionId = data.session_id;

      // ✅ バックエンドからの初回メッセージを使用（長期記憶対応）
      const greetingText = data.initial_message || this.t('initialGreetingConcierge');
      this.addMessage('assistant', greetingText, null, true);
      
      const ackTexts = [
        this.t('ackConfirm'), this.t('ackSearch'), this.t('ackUnderstood'), 
        this.t('ackYes'), this.t('ttsIntro')
      ];
      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];
      
      const ackPromises = ackTexts.map(async (text) => {
        try {
          const ackResponse = await fetch(`${this.apiBase}/api/tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              text: text, language_code: langConfig.tts, voice_name: langConfig.voice 
            })
          });
          const ackData = await ackResponse.json();
          if (ackData.success && ackData.audio) {
            this.preGeneratedAcks.set(text, ackData.audio);
          }
        } catch (_e) { }
      });

      await Promise.all([
        this.speakTextGCP(greetingText), 
        ...ackPromises
      ]);
      
      this.els.userInput.disabled = false;
      this.els.sendBtn.disabled = false;
      this.els.micBtn.disabled = false;
      this.els.speakerBtn.disabled = false;
      this.els.speakerBtn.classList.remove('disabled');
      this.els.reservationBtn.classList.remove('visible');

    } catch (e) {
      console.error('[Session] Initialization error:', e);
    }
  }

  // ========================================
  // 🔧 Socket.IOの初期化をオーバーライド
  // ========================================
  protected initSocket() {
    // @ts-ignore
    this.socket = io(this.apiBase || window.location.origin);
    
    this.socket.on('connect', () => { });
    
    // ✅ コンシェルジュ版のhandleStreamingSTTCompleteを呼ぶように再登録
    this.socket.on('transcript', (data: any) => {
      const { text, is_final } = data;
      if (this.isAISpeaking) return;
      if (is_final) {
        this.handleStreamingSTTComplete(text); // ← オーバーライド版が呼ばれる
        this.currentAISpeech = "";
      } else {
        this.els.userInput.value = text;
      }
    });

    this.socket.on('error', (data: any) => {
      this.addMessage('system', `${this.t('sttError')} ${data.message}`);
      if (this.isRecording) this.stopStreamingSTT();
    });
  }

  // コンシェルジュモード固有: アバターアニメーション制御
  protected async speakTextGCP(text: string, stopPrevious: boolean = true, autoRestartMic: boolean = false, skipAudio: boolean = false) {
    if (skipAudio || !this.isTTSEnabled || !text) return Promise.resolve();

    if (stopPrevious) {
      this.ttsPlayer.pause();
    }
    
    // アバターアニメーションを開始
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.add('speaking');
    }
    
    // 親クラスのTTS処理を実行
    await super.speakTextGCP(text, stopPrevious, autoRestartMic, skipAudio);
    
    // アバターアニメーションを停止
    this.stopAvatarAnimation();
  }

  // アバターアニメーション停止
  private stopAvatarAnimation() {
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.remove('speaking');
    }
  }

  // ========================================
  // 🎯 UI言語更新をオーバーライド(挨拶文をコンシェルジュ用に)
  // ========================================
  protected updateUILanguage() {
    // 親クラスのupdateUILanguageを実行
    super.updateUILanguage();
    
    // ✅ 初期メッセージをコンシェルジュ用に再設定
    const initialMessage = this.els.chatArea.querySelector('.message.assistant[data-initial="true"] .message-text');
    if (initialMessage) {
      initialMessage.textContent = this.t('initialGreetingConcierge');
    }
  }

  // ★★★ 修正: モード切り替え処理の安定化 ★★★
  private toggleMode() {
    const isChecked = this.els.modeSwitch?.checked;
    
    if (!isChecked) {
      console.log('[ConciergeController] Switching to Chat mode...');
      
      // ★ ステップ1: すべての処理を停止
      this.stopAllActivities();
      
      // ★ ステップ2: 少し待ってからページ遷移（非同期処理の完了を待つ）
      setTimeout(() => {
        console.log('[ConciergeController] Navigating to /');
        window.location.href = '/';
      }, 150);
    }
    // コンシェルジュモードは既に現在のページなので何もしない
  }

  // すべての活動を停止(アバターアニメーションも含む)
  protected stopAllActivities() {
    super.stopAllActivities();
    this.stopAvatarAnimation();
  }

  // ========================================
  // 🎯 並行処理フロー: 応答を分割してTTS処理
  // ========================================

  /**
   * センテンス単位でテキストを分割
   * 日本語: 。で分割
   * 英語・韓国語: . で分割
   * 中国語: 。で分割
   */
  private splitIntoSentences(text: string, language: string): string[] {
    let separator: RegExp;

    if (language === 'ja' || language === 'zh') {
      // 日本語・中国語: 。で分割
      separator = /。/;
    } else {
      // 英語・韓国語: . で分割
      separator = /\.\s+/;
    }

    const parts = text.split(separator);
    const sentences: string[] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!part) continue;

      // 区切り文字を復元
      if (language === 'ja' || language === 'zh') {
        // 最後の要素以外は。を付け直す
        sentences.push(i < parts.length - 1 ? part + '。' : part);
      } else {
        sentences.push(i < parts.length - 1 ? part + '.' : part);
      }
    }

    return sentences;
  }

  /**
   * 並行処理でTTSを再生しつつ、次のTTSを生成
   * @param text AIからのレスポンス全文
   * @param isTextInput テキスト入力かどうか
   */
  private async speakResponseInChunks(text: string, isTextInput: boolean = false) {
    if (!text || isTextInput || !this.isTTSEnabled) return;

    try {
      this.isAISpeaking = true;
      if (this.isRecording) {
        this.stopStreamingSTT();
      }

      const sentences = this.splitIntoSentences(text, this.currentLanguage);
      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];

      for (let i = 0; i < sentences.length; i++) {
        const currentSentence = sentences[i];
        const nextSentence = sentences[i + 1] || null;

        // 現在のセンテンスのTTS生成
        const currentAudioPromise = (async () => {
          const cleanText = this.stripMarkdown(currentSentence);
          const response = await fetch(`${this.apiBase}/api/tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: cleanText,
              language_code: langConfig.tts,
              voice_name: langConfig.voice
            })
          });
          const result = await response.json();
          return result.success ? `data:audio/mp3;base64,${result.audio}` : null;
        })();

        // 次のセンテンスのTTS生成（並行実行）
        let nextAudioPromise: Promise<string | null> | null = null;
        if (nextSentence) {
          nextAudioPromise = (async () => {
            const cleanText = this.stripMarkdown(nextSentence);
            const response = await fetch(`${this.apiBase}/api/tts/synthesize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: cleanText,
                language_code: langConfig.tts,
                voice_name: langConfig.voice
              })
            });
            const result = await response.json();
            return result.success ? `data:audio/mp3;base64,${result.audio}` : null;
          })();
        }

        // 現在のセンテンスを再生
        const currentAudio = await currentAudioPromise;
        if (currentAudio) {
          this.lastAISpeech = this.normalizeText(this.stripMarkdown(currentSentence));
          
          if (!isTextInput && this.isTTSEnabled) {
            this.stopCurrentAudio();
          }

          this.ttsPlayer.src = currentAudio;
          await new Promise<void>((resolve) => {
            this.ttsPlayer.onended = () => {
              this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
              this.els.voiceStatus.className = 'voice-status stopped';
              resolve();
            };
            this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
            this.els.voiceStatus.className = 'voice-status speaking';
            this.ttsPlayer.play();
          });

          // 次の音声がある場合は少し待機（自然な間を作る）
          if (nextAudioPromise) {
            await new Promise(r => setTimeout(r, 300));
          }
        }
      }

      this.isAISpeaking = false;
    } catch (error) {
      console.error('[speakResponseInChunks] Error:', error);
      this.isAISpeaking = false;
    }
  }

  // ========================================
  // 🎯 ストリーミングSTT完了時の処理をオーバーライド
  // ========================================
  protected async handleStreamingSTTComplete(text: string) {
    if (!text.trim()) return;
    
    // 音声入力フラグを立てる
    this.isFromVoiceInput = true;
    
    // ユーザーメッセージを追加（AIの発言を遮断した可能性を示す）
    this.addMessage('user', text);
    
    // 入力欄をクリア
    this.els.userInput.value = '';
    
    // メッセージ送信
    await this.sendMessage(text);
  }

  // ========================================
  // 🎯 メッセージ送信処理をオーバーライド
  // ========================================
  protected async sendMessage(message: string) {
    if (this.isProcessing || !message.trim()) return;
    
    this.isProcessing = true;
    const currentSessionId = this.sessionId;
    
    // ✅ 音声入力から来た場合の即座の応答
    if (this.isFromVoiceInput) {
      const ackTexts = [
        this.t('ackConfirm'),
        this.t('ackSearch'),
        this.t('ackUnderstood'),
        this.t('ackYes')
      ];
      const randomAck = ackTexts[Math.floor(Math.random() * ackTexts.length)];
      
      let firstAckPromise: Promise<void> | null = null;
      const preGeneratedAck = this.preGeneratedAcks.get(randomAck);
      
      if (preGeneratedAck) {
        firstAckPromise = new Promise<void>((resolve) => {
          this.lastAISpeech = this.normalizeText(randomAck);
          this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAck}`;
          this.ttsPlayer.onended = () => resolve();
          this.ttsPlayer.play();
        });
      } else {
        firstAckPromise = this.speakTextGCP(randomAck, true);
      }
      
      if (firstAckPromise) await firstAckPromise;
      
      // ✅ 修正: オウム返しパターンを削除
      // (generateFallbackResponse, additionalResponse の呼び出しを削除)
    }

    this.isFromVoiceInput = false;
    
    // ✅ 待機アニメーションは8秒後に表示(LLM送信直前にタイマースタート)
    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    let responseReceived = false;
    
    // タイマーセットをtry直前に移動(即答処理の後)
    this.waitOverlayTimer = window.setTimeout(() => { 
      if (!responseReceived) {
        this.showWaitOverlay(); 
      }
    }, 8000);

    try {
      const response = await fetch(`${this.apiBase}/api/chat`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ 
          session_id: currentSessionId, 
          message: message, 
          stage: this.currentStage, 
          language: this.currentLanguage,
          mode: this.currentMode
        }) 
      });
      const data = await response.json();
      
      // ✅ レスポンス到着フラグを立てる
      responseReceived = true;
      
      if (this.sessionId !== currentSessionId) return;
      
      // ✅ タイマーをクリアしてアニメーションを非表示
      if (this.waitOverlayTimer) {
        clearTimeout(this.waitOverlayTimer);
        this.waitOverlayTimer = null;
      }
      this.hideWaitOverlay();
      this.currentAISpeech = data.response;
      this.addMessage('assistant', data.response, data.summary);
      
      if (!this.isFromVoiceInput && this.isTTSEnabled) {
        this.stopCurrentAudio();
      }
      
      if (data.shops && data.shops.length > 0) {
        this.currentShops = data.shops;
        this.els.reservationBtn.classList.add('visible');
        this.els.userInput.value = '';
        document.dispatchEvent(new CustomEvent('displayShops', { 
          detail: { shops: data.shops, language: this.currentLanguage } 
        }));
        
        const section = document.getElementById('shopListSection');
        if (section) section.classList.add('has-shops');
        if (window.innerWidth < 1024) {
          setTimeout(() => {
            const shopSection = document.getElementById('shopListSection');
            if (shopSection) shopSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
           }, 300);
        }
        
        (async () => {
          try {
            this.isAISpeaking = true;
            if (this.isRecording) { this.stopStreamingSTT(); }

            await this.speakTextGCP(this.t('ttsIntro'), true, false, false);
            
            const lines = data.response.split('\n\n');
            let introText = ""; 
            let shopLines = lines;
            if (lines[0].includes('ご希望に合うお店') && lines[0].includes('ご紹介します')) { 
              introText = lines[0]; 
              shopLines = lines.slice(1); 
            }
            
            let introPart2Promise: Promise<void> | null = null;
            if (introText && this.isTTSEnabled && this.isUserInteracted) {
                const preGeneratedIntro = this.preGeneratedAcks.get(introText);
              if (preGeneratedIntro) {
                introPart2Promise = new Promise<void>((resolve) => {
                  this.lastAISpeech = this.normalizeText(introText);
                  this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedIntro}`;
                  this.ttsPlayer.onended = () => resolve();
                  this.ttsPlayer.play();
                });
              } else { 
                introPart2Promise = this.speakTextGCP(introText, false, false, false); 
              }
            }

            let firstShopAudioPromise: Promise<string | null> | null = null;
            let remainingAudioPromise: Promise<string | null> | null = null;
            const shopLangConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];
            
            if (shopLines.length > 0 && this.isTTSEnabled && this.isUserInteracted) {
              const firstShop = shopLines[0];
              const restShops = shopLines.slice(1).join('\n\n');              
              firstShopAudioPromise = (async () => {
                const cleanText = this.stripMarkdown(firstShop);
                const response = await fetch(`${this.apiBase}/api/tts/synthesize`, { 
                  method: 'POST', 
                  headers: { 'Content-Type': 'application/json' }, 
                  body: JSON.stringify({ 
                    text: cleanText, language_code: shopLangConfig.tts, voice_name: shopLangConfig.voice 
                  }) 
                });
                const result = await response.json();
                return result.success ? `data:audio/mp3;base64,${result.audio}` : null;
              })();
              
              if (restShops) {
                remainingAudioPromise = (async () => {
                  const cleanText = this.stripMarkdown(restShops);
                  const response = await fetch(`${this.apiBase}/api/tts/synthesize`, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ 
                      text: cleanText, language_code: shopLangConfig.tts, voice_name: shopLangConfig.voice 
                    }) 
                  });
                  const result = await response.json();
                  return result.success ? `data:audio/mp3;base64,${result.audio}` : null;
                })();
              }
            }

            if (introPart2Promise) await introPart2Promise;
            
            if (firstShopAudioPromise) {
              const firstShopAudio = await firstShopAudioPromise;
              if (firstShopAudio) {
                const firstShopText = this.stripMarkdown(shopLines[0]);
                this.lastAISpeech = this.normalizeText(firstShopText);
                
                if (this.isTTSEnabled) {
                  this.stopCurrentAudio();
                }
                
                this.ttsPlayer.src = firstShopAudio;                
                await new Promise<void>((resolve) => { 
                  this.ttsPlayer.onended = () => { 
                    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped'); 
                    this.els.voiceStatus.className = 'voice-status stopped'; 
                    resolve(); 
                  }; 
                  this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking'); 
                  this.els.voiceStatus.className = 'voice-status speaking'; 
                  this.ttsPlayer.play(); 
                });
                
                if (remainingAudioPromise) {
                  const remainingAudio = await remainingAudioPromise;
                  if (remainingAudio) {
                    const restShopsText = this.stripMarkdown(shopLines.slice(1).join('\n\n'));
                    this.lastAISpeech = this.normalizeText(restShopsText);
                    await new Promise(r => setTimeout(r, 500));
                    
                    if (this.isTTSEnabled) {
                      this.stopCurrentAudio();
                    }
                    
                    this.ttsPlayer.src = remainingAudio;                    
                    await new Promise<void>((resolve) => { 
                      this.ttsPlayer.onended = () => { 
                        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped'); 
                        this.els.voiceStatus.className = 'voice-status stopped'; 
                        resolve(); 
                      }; 
                      this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking'); 
                      this.els.voiceStatus.className = 'voice-status speaking'; 
                      this.ttsPlayer.play(); 
                    });
                  }
                }
              }
            }
            this.isAISpeaking = false;
          } catch (_e) { this.isAISpeaking = false; }
        })();
      } else {
        if (data.response) {
          const extractedShops = this.extractShopsFromResponse(data.response);
          if (extractedShops.length > 0) {
            this.currentShops = extractedShops;
            this.els.reservationBtn.classList.add('visible');
            document.dispatchEvent(new CustomEvent('displayShops', {
              detail: { shops: extractedShops, language: this.currentLanguage }
            }));
            const section = document.getElementById('shopListSection');
            if (section) section.classList.add('has-shops');
            // ★並行処理フローを適用
            this.speakResponseInChunks(data.response, false);
          } else {
            // ★並行処理フローを適用
            this.speakResponseInChunks(data.response, false);
          }
        }
      }
    } catch (error) { 
      console.error('送信エラー:', error);
      this.hideWaitOverlay(); 
      this.showError('メッセージの送信に失敗しました。'); 
    } finally { 
      this.resetInputState();
      this.els.userInput.blur();
    }
  }

}
