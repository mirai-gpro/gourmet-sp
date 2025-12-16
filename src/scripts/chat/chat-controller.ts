// src/scripts/chat/chat-controller.ts
import { i18n } from '../../constants/i18n'; 
import { AudioManager } from './audio-manager';

declare const io: any;

export class ChatController {
  private container: HTMLElement;
  private apiBase: string;
  private audioManager: AudioManager;
  private socket: any = null;
  
  // オリジナルの状態変数
  private currentLanguage: 'ja' | 'en' | 'zh' | 'ko' = 'ja';
  private sessionId: string | null = null;
  private isProcessing = false;
  private currentStage = 'conversation';
  private isRecording = false; 
  private waitOverlayTimer: number | null = null;
  private isTTSEnabled = true;
  private isUserInteracted = false;
  private currentShops: any[] = [];
  private isFromVoiceInput = false;
  private lastAISpeech = '';
  private preGeneratedAcks: Map<string, string> = new Map();
  private isAISpeaking = false;
  private currentAISpeech = "";
  
  // 修正: iOS判定プロパティを追加
  private isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  private isAndroid = /Android/i.test(navigator.userAgent);

  private els: any = {};
  private ttsPlayer: HTMLAudioElement;

  private readonly LANGUAGE_CODE_MAP = {
    ja: { tts: 'ja-JP', stt: 'ja-JP', voice: 'ja-JP-Chirp3-HD-Leda' },
    en: { tts: 'en-US', stt: 'en-US', voice: 'en-US-Studio-O' },
    zh: { tts: 'cmn-CN', stt: 'cmn-CN', voice: 'cmn-CN-Wavenet-A' },
    ko: { tts: 'ko-KR', stt: 'ko-KR', voice: 'ko-KR-Wavenet-A' }
  };

  constructor(container: HTMLElement, apiBase: string) {
    this.container = container;
    this.apiBase = apiBase;
    // 修正: isIOSフラグをAudioManagerに渡す
    this.audioManager = new AudioManager(this.isIOS);
    this.ttsPlayer = new Audio(); 

    // DOM要素取得
    const query = (sel: string) => container.querySelector(sel) as HTMLElement;
    this.els = {
      chatArea: query('#chatArea'),
      userInput: query('#userInput') as HTMLInputElement,
      sendBtn: query('#sendBtn'),
      micBtn: query('#micBtnFloat'),
      speakerBtn: query('#speakerBtn'),
      voiceStatus: query('#voiceStatus'),
      waitOverlay: query('#waitOverlay'),
      waitVideo: query('#waitVideo') as HTMLVideoElement,
      splashOverlay: query('#splashOverlay'),
      splashVideo: query('#splashVideo') as HTMLVideoElement,
      reservationBtn: query('#reservationBtn'),
      stopBtn: query('#stopBtn'),
      languageSelect: query('#languageSelect') as HTMLSelectElement
    };

    this.init();
  }

  private async init() {
    this.bindEvents();
    this.initSocket();
    
    // スプラッシュ画面のフェイルセーフ
    setTimeout(() => {
        if (this.els.splashVideo) this.els.splashVideo.loop = false;
        if (this.els.splashOverlay) {
             this.els.splashOverlay.classList.add('fade-out');
             setTimeout(() => this.els.splashOverlay.classList.add('hidden'), 800);
        }
    }, 10000);

    await this.initializeSession();
    this.updateUILanguage();
    
    setTimeout(() => {
      if (this.els.splashOverlay) {
        this.els.splashOverlay.classList.add('fade-out');
        setTimeout(() => this.els.splashOverlay.classList.add('hidden'), 800);
      }
    }, 2000);
  }

  private bindEvents() {
    this.els.sendBtn.addEventListener('click', () => this.sendMessage());
    this.els.micBtn.addEventListener('click', () => this.toggleRecording());
    this.els.speakerBtn.addEventListener('click', () => this.toggleTTS());
    this.els.reservationBtn.addEventListener('click', () => this.openReservationModal());
    this.els.stopBtn.addEventListener('click', () => this.stopAllActivities());
    
    this.els.userInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') this.sendMessage();
    });
    
    this.els.languageSelect.addEventListener('change', () => {
      this.currentLanguage = this.els.languageSelect.value as any;
      this.updateUILanguage();
    });

    this.container.addEventListener('click', () => this.enableAudioPlayback(), { once: true });
    
    const floatingButtons = this.container.querySelector('.floating-buttons');
    this.els.userInput.addEventListener('focus', () => {
      setTimeout(() => { if (floatingButtons) floatingButtons.classList.add('keyboard-active'); }, 300);
    });
    this.els.userInput.addEventListener('blur', () => {
      if (floatingButtons) floatingButtons.classList.remove('keyboard-active');
    });
  }

  private initSocket() {
    // @ts-ignore
    this.socket = io(this.apiBase || window.location.origin);
    
    this.socket.on('connect', () => { });
    
    this.socket.on('transcript', (data: any) => {
      const { text, is_final } = data;
      if (this.isAISpeaking) return;
      if (is_final) {
        this.handleStreamingSTTComplete(text);
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

  private async initializeSession() {
    try {
      const res = await fetch(`${this.apiBase}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_info: {}, language: this.currentLanguage })
      });
      const data = await res.json();
      this.sessionId = data.session_id;
      
      this.addMessage('assistant', this.t('initialGreeting'), null, true);
      
      const ackTexts = [
        this.t('ackConfirm'), 
        this.t('ackSearch'), 
        this.t('ackUnderstood'), 
        this.t('ackYes'), 
        this.t('ttsIntro')
      ];
      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];
      
      const ackPromises = ackTexts.map(async (text) => {
        try {
          const ackResponse = await fetch(`${this.apiBase}/api/tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              text: text, 
              language_code: langConfig.tts, 
              voice_name: langConfig.voice 
            })
          });
          const ackData = await ackResponse.json();
          if (ackData.success && ackData.audio) {
            this.preGeneratedAcks.set(text, ackData.audio);
          }
        } catch (_e) { /* エラー無視 */ }
      });

      await Promise.all([
        this.speakTextGCP(this.t('initialGreeting')), 
        ...ackPromises
      ]);
      
      this.els.userInput.disabled = false;
      this.els.sendBtn.disabled = false;
      this.els.micBtn.disabled = false;
      this.els.speakerBtn.disabled = false;
      this.els.userInput.focus();

    } catch (e) {
      console.error(e);
    }
  }

  private async toggleRecording() {
    this.enableAudioPlayback();
    this.els.userInput.value = '';
    this.stopCurrentAudio();
    
    if (this.isRecording) { 
      this.stopAllActivities();
      return;
    }
    
    if (this.socket && this.socket.connected) {
        this.isRecording = true;
        this.els.micBtn.classList.add('recording');
        this.els.voiceStatus.innerHTML = this.t('voiceStatusListening');
        this.els.voiceStatus.className = 'voice-status listening';

        try {
          const langCode = this.LANGUAGE_CODE_MAP[this.currentLanguage].stt;
          
          await this.audioManager.startStreaming(
            this.socket, 
            langCode, 
            () => { this.stopStreamingSTT(); },
            () => { 
                this.els.voiceStatus.innerHTML = this.t('voiceStatusRecording');
            }
          );
        } catch (error: any) {
          this.stopStreamingSTT();
          if (!error.message?.includes('マイク')) {
              this.showError(this.t('micAccessError'));
          }
        }
    } else {
        await this.startLegacyRecording();
    }
  }
  
  private async startLegacyRecording() {
      try {
          this.isRecording = true;
          this.els.micBtn.classList.add('recording');
          this.els.voiceStatus.innerHTML = this.t('voiceStatusListening');
          
          await this.audioManager.startLegacyRecording(
              async (audioBlob) => {
                  await this.transcribeAudio(audioBlob);
                  this.stopStreamingSTT(); 
              },
              () => { 
                  this.els.voiceStatus.innerHTML = this.t('voiceStatusRecording');
              }
          );
      } catch (error: any) {
          this.addMessage('system', `${this.t('micAccessError')} ${error.message}`);
          this.stopStreamingSTT();
      }
  }
  
  private async transcribeAudio(audioBlob: Blob) {
      // 未使用変数のエラー回避のためログ出力
      console.log('Legacy audio blob size:', audioBlob.size);
  }

  private stopStreamingSTT() {
    this.audioManager.stopStreaming();
    if (this.socket && this.socket.connected) {
        this.socket.emit('stop_stream');
    }
    this.isRecording = false;
    this.els.micBtn.classList.remove('recording');
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }

  private async handleStreamingSTTComplete(transcript: string) {
    this.stopStreamingSTT();
    this.els.voiceStatus.innerHTML = this.t('voiceStatusComplete');
    this.els.voiceStatus.className = 'voice-status';

    const normTranscript = this.normalizeText(transcript);
    if (this.isSemanticEcho(normTranscript, this.lastAISpeech)) {
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        this.lastAISpeech = '';
        return;
    }

    this.els.userInput.value = transcript;
    
    // @ts-ignore
    if (i18n[this.currentLanguage].patterns.dateCheck.test(transcript)) {
      const msg = this.t('dateWarningMsg');
      this.currentAISpeech = msg;
      this.addMessage('assistant', msg);
      if (this.isTTSEnabled && this.isUserInteracted) {
        await this.speakTextGCP(msg, true, true);
      } else { 
        await new Promise(r => setTimeout(r, 2000)); 
      }
      this.els.userInput.value = '';
      this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
      this.els.voiceStatus.className = 'voice-status stopped';
      return;
    }

    this.addMessage('user', transcript);
    const textLength = transcript.trim().replace(/\s+/g, '').length;
    if (textLength < 4) {
        const msg = this.t('shortMsgWarning');
        this.addMessage('assistant', msg);
        if (this.isTTSEnabled && this.isUserInteracted) {
          await this.speakTextGCP(msg, true);
        } else { 
          await new Promise(r => setTimeout(r, 2000)); 
        }
        this.els.userInput.value = '';
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        return;
    }

    const ack = this.selectSmartAcknowledgment(transcript);
    const preGeneratedAudio = this.preGeneratedAcks.get(ack.text);
    
    let firstAckPromise: Promise<void> | null = null;
    if (preGeneratedAudio && this.isTTSEnabled && this.isUserInteracted) {
      firstAckPromise = new Promise<void>((resolve) => {
        this.lastAISpeech = this.normalizeText(ack.text);
        this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAudio}`;
        this.ttsPlayer.onended = () => resolve();
        this.ttsPlayer.play().catch(_e => resolve());
      });
    } else if (this.isTTSEnabled) { 
      firstAckPromise = this.speakTextGCP(ack.text, false); 
    }
    
    this.addMessage('assistant', ack.text);
    
    (async () => {
      try {
        if (firstAckPromise) await firstAckPromise;
        const cleanText = this.removeFillers(transcript);
        const fallbackResponse = this.generateFallbackResponse(cleanText);
        
        if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(fallbackResponse, false);
        this.addMessage('assistant', fallbackResponse);
        
        setTimeout(async () => {
          const additionalResponse = this.t('additionalResponse');
          if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(additionalResponse, false);
          this.addMessage('assistant', additionalResponse);
        }, 3000);
        
        if (this.els.userInput.value.trim()) {
          this.isFromVoiceInput = true;
          this.sendMessage();
        }
      } catch (_error) { // 変数名を_errorに変更して未使用エラーを回避
        if (this.els.userInput.value.trim()) {
          this.isFromVoiceInput = true;
          this.sendMessage();
        }
      }
    })();
    
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }

  private async sendMessage() {
    let firstAckPromise: Promise<void> | null = null; 
    this.unlockAudioParams();
    const message = this.els.userInput.value.trim();
    if (!message || this.isProcessing) return;
    
    this.isProcessing = true; 
    this.els.sendBtn.disabled = true;
    this.els.micBtn.disabled = true; 
    this.els.userInput.disabled = true;

    if (!this.isFromVoiceInput) {
      this.addMessage('user', message);
      
      // @ts-ignore
      if (i18n[this.currentLanguage].patterns.dateCheck.test(message)) {
           const msg = this.t('dateWarningMsg');
           if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(msg, true);
           this.addMessage('assistant', msg);
           this.resetInputState();
           return;
      }
      
      const textLength = message.trim().replace(/\s+/g, '').length;
      if (textLength < 4) {
           const msg = this.t('shortMsgWarning');
           this.addMessage('assistant', msg);
           if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(msg, true);
           this.resetInputState();
           return;
      }
      
      this.els.userInput.value = '';
      
      const ack = this.selectSmartAcknowledgment(message);
      this.currentAISpeech = ack.text;
      this.addMessage('assistant', ack.text);
      
      if (this.isTTSEnabled) {
        try {
          const preGeneratedAudio = this.preGeneratedAcks.get(ack.text);
          if (preGeneratedAudio && this.isUserInteracted) {
            firstAckPromise = new Promise<void>((resolve) => {
              this.lastAISpeech = this.normalizeText(ack.text);
              this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAudio}`;
              this.ttsPlayer.onended = () => resolve();
              this.ttsPlayer.play().catch(_e => resolve());
            });
          } else { 
            firstAckPromise = this.speakTextGCP(ack.text, false); 
          }
        } catch (_e) {}
      }
      
      if (firstAckPromise) await firstAckPromise;
      
      const cleanText = this.removeFillers(message);
      const fallbackResponse = this.generateFallbackResponse(cleanText);
      
      if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(fallbackResponse, false);
      this.addMessage('assistant', fallbackResponse);
      
      setTimeout(async () => {
        const additionalResponse = this.t('additionalResponse');
        if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(additionalResponse, false);
        this.addMessage('assistant', additionalResponse);
      }, 3000);
    }

    this.isFromVoiceInput = false;
    
    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    this.waitOverlayTimer = window.setTimeout(() => { this.showWaitOverlay(); }, 4000);

    try {
      const response = await fetch(`${this.apiBase}/api/chat`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ 
          session_id: this.sessionId, 
          message: message, 
          stage: this.currentStage, 
          language: this.currentLanguage 
        }) 
      });
      const data = await response.json();
      
      this.hideWaitOverlay();
      this.currentAISpeech = data.response;
      this.addMessage('assistant', data.response, data.summary);
      this.stopCurrentAudio();
      
      if (data.shops && data.shops.length > 0) {
        this.currentShops = data.shops;
        this.els.reservationBtn.disabled = false;
        this.els.userInput.value = '';
        document.dispatchEvent(new CustomEvent('displayShops', { 
          detail: { shops: data.shops, language: this.currentLanguage } 
        }));
        
        const section = document.getElementById('shopListSection');
        if (section) section.classList.add('has-shops');
        if (window.innerWidth < 1024) {
          setTimeout(() => {
            const shopSection = document.getElementById('shopListSection');
            if (shopSection) {
              shopSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
           }, 300);
        }
        
        (async () => {
          try {
            this.isAISpeaking = true;
            if (this.isRecording) { this.stopStreamingSTT(); }

            await this.speakTextGCP(this.t('ttsIntro'));
            
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
                introPart2Promise = this.speakTextGCP(introText, false); 
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
                    text: cleanText, 
                    language_code: shopLangConfig.tts, 
                    voice_name: shopLangConfig.voice 
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
                      text: cleanText, 
                      language_code: shopLangConfig.tts, 
                      voice_name: shopLangConfig.voice 
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
                this.stopCurrentAudio(); 
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
                    
                    this.stopCurrentAudio(); 
                    this.ttsPlayer.src = remainingAudio;
                    
                    await new Promise<void>((resolve) => { 
                      this.ttsPlayer.onended = () => { 
                        this.els.voiceStatus.innerHTML = '🎤 音声認識: 停止中'; 
                        this.els.voiceStatus.className = 'voice-status stopped'; 
                        resolve(); 
                      }; 
                      this.els.voiceStatus.innerHTML = '🔊 音声再生中...'; 
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
            this.els.reservationBtn.disabled = false;
            document.dispatchEvent(new CustomEvent('displayShops', { 
              detail: { shops: extractedShops, language: this.currentLanguage } 
            }));
            const section = document.getElementById('shopListSection');
            if (section) section.classList.add('has-shops');
            this.speakTextGCP(data.response);
          } else { 
            this.speakTextGCP(data.response); 
          }
        }
      }
    } catch (error) { 
      console.error('送信エラー:', error);
      this.hideWaitOverlay(); 
      this.showError('メッセージの送信に失敗しました。'); 
    } finally { 
      this.resetInputState();
      if (this.currentShops.length === 0) this.els.userInput.focus(); 
      else this.els.userInput.blur();
    }
  }

  // --- ヘルパーメソッド群 ---

  private async speakTextGCP(text: string, stopPrevious: boolean = true, autoRestartMic: boolean = false) {
    if (!this.isTTSEnabled || !text) return;
    if (stopPrevious) this.ttsPlayer.pause();
    
    const cleanText = this.stripMarkdown(text);

    try {
      this.isAISpeaking = true;
      
      // 修正: iOSまたはAndroid録音中の場合のハンドリングを強化
      if (this.isIOS || (this.isAndroid && this.isRecording)) {
         this.stopStreamingSTT();
      }
      
      this.els.voiceStatus.innerHTML = this.t('voiceStatusSynthesizing');
      this.els.voiceStatus.className = 'voice-status speaking';
      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];
      
      const response = await fetch(`${this.apiBase}/api/tts/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          text: cleanText, 
          language_code: langConfig.tts, 
          voice_name: langConfig.voice 
        })
      });
      const data = await response.json();
      if (data.success && data.audio) {
        this.ttsPlayer.src = `data:audio/mp3;base64,${data.audio}`;
        const playPromise = new Promise<void>((resolve) => {
          this.ttsPlayer.onended = async () => {
            this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
            this.els.voiceStatus.className = 'voice-status stopped';
            this.isAISpeaking = false;
            
            if (autoRestartMic) {
              if (!this.isRecording) {
                try {
                  await this.toggleRecording();
                } catch (_error) { // 未使用変数回避
                  this.showMicPrompt();
                }
              }
            }
            resolve();
          };
          this.ttsPlayer.onerror = () => { 
            this.isAISpeaking = false;
            resolve(); 
          };
        });
        
        if (this.isUserInteracted) {
          this.lastAISpeech = this.normalizeText(cleanText);
          await this.ttsPlayer.play();
          await playPromise;
        } else {
          this.showClickPrompt();
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
          this.isAISpeaking = false;
        }
      } else {
        this.isAISpeaking = false;
      }
    } catch (_error) {
      this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
      this.els.voiceStatus.className = 'voice-status stopped';
      this.isAISpeaking = false;
    }
  }

  private showWaitOverlay() {
    this.els.waitOverlay.classList.remove('hidden');
    this.els.waitVideo.currentTime = 0;
    this.els.waitVideo.play().catch((e: any) => console.log('Video err', e));
  }

  private hideWaitOverlay() {
    if (this.waitOverlayTimer) { clearTimeout(this.waitOverlayTimer); this.waitOverlayTimer = null; }
    this.els.waitOverlay.classList.add('hidden');
    setTimeout(() => this.els.waitVideo.pause(), 500);
  }

  private unlockAudioParams() {
    this.audioManager.unlockAudioParams(this.ttsPlayer);
  }

  private enableAudioPlayback() {
    if (!this.isUserInteracted) {
      this.isUserInteracted = true;
      const clickPrompt = this.container.querySelector('.click-prompt');
      if (clickPrompt) clickPrompt.remove();
      this.unlockAudioParams();
    }
  }

  private stopCurrentAudio() {
    this.ttsPlayer.pause();
    this.ttsPlayer.currentTime = 0;
  }

  private showClickPrompt() {
    const prompt = document.createElement('div');
    prompt.className = 'click-prompt';
    prompt.innerHTML = `<p>🔊</p><p>${this.t('clickPrompt')}</p><p>🔊</p>`;
    prompt.addEventListener('click', () => this.enableAudioPlayback());
    this.container.style.position = 'relative';
    this.container.appendChild(prompt);
  }

  private showMicPrompt() {
    const modal = document.createElement('div');
    modal.id = 'mic-prompt-modal';
    modal.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000; animation: fadeIn 0.3s ease;`;
    modal.innerHTML = `
      <div style="background: white; border-radius: 16px; padding: 24px; max-width: 90%; width: 350px; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.3);">
        <div style="font-size: 48px; margin-bottom: 16px;">🎤</div>
        <div style="font-size: 18px; font-weight: 700; margin-bottom: 8px; color: #333;">マイクをONにしてください</div>
        <div style="font-size: 14px; color: #666; margin-bottom: 20px;">AIの回答が終わりました。<br>続けて話すにはマイクボタンをタップしてください。</div>
        <button id="mic-prompt-btn" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; padding: 14px 32px; border-radius: 24px; font-size: 16px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);">🎤 マイクON</button>
      </div>
    `;
    const style = document.createElement('style');
    style.textContent = `@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }`;
    document.head.appendChild(style);
    document.body.appendChild(modal);
    
    const btn = document.getElementById('mic-prompt-btn');
    btn?.addEventListener('click', async () => {
      modal.remove();
      await this.toggleRecording();
    });
    setTimeout(() => { if (document.getElementById('mic-prompt-modal')) { modal.remove(); } }, 3000);
  }

  // --- 文字列処理・その他 ---

  private stripMarkdown(text: string): string {
    return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1').replace(/^#+\s*/gm, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^(\d+)\.\s+/gm, '$1番目、').replace(/\s+/g, ' ').trim();
  }

  private normalizeText(text: string): string {
    return text.replace(/\s+/g, '').replace(/[、。！？,.!?]/g, '').toLowerCase();
  }

  private removeFillers(text: string): string {
    // @ts-ignore
    const pattern = i18n[this.currentLanguage].patterns.fillers;
    return text.replace(pattern, '');
  }

  private generateFallbackResponse(text: string): string {
    return this.t('fallbackResponse', text);
  }

  private selectSmartAcknowledgment(userMessage: string) {
    const messageLower = userMessage.trim();
    // @ts-ignore
    const p = i18n[this.currentLanguage].patterns;
    if (p.ackQuestions.test(messageLower)) return { text: this.t('ackConfirm'), logText: `質問形式` };
    if (p.ackLocation.test(messageLower)) return { text: this.t('ackSearch'), logText: `場所` };
    if (p.ackSearch.test(messageLower)) return { text: this.t('ackUnderstood'), logText: `検索` };
    return { text: this.t('ackYes'), logText: `デフォルト` };
  }

  private isSemanticEcho(transcript: string, aiText: string): boolean {
    if (!aiText || !transcript) return false;
    const normTranscript = this.normalizeText(transcript);
    const normAI = this.normalizeText(aiText);
    if (normAI === normTranscript) return true;
    if (normAI.includes(normTranscript) && normTranscript.length > 5) return true;
    return false;
  }

  private extractShopsFromResponse(text: string): any[] {
    const shops: any[] = [];
    const pattern = /(\d+)\.\s*\*\*([^*]+)\*\*[::\s]*([^\n]+)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const fullName = match[2].trim();
      const description = match[3].trim();
      let name = fullName;
      const nameMatch = fullName.match(/^([^(]+)[(]([^)]+)[)]/);
      if (nameMatch) name = nameMatch[1].trim();
      const encodedName = encodeURIComponent(name);
      shops.push({ name: name, description: description, category: 'イタリアン', hotpepper_url: `https://www.hotpepper.jp/SA11/srchRS/?keyword=${encodedName}`, maps_url: `https://www.google.com/maps/search/${encodedName}`, tabelog_url: `https://tabelog.com/rstLst/?vs=1&sa=&sk=${encodedName}` });
    }
    return shops;
  }

  private openReservationModal() {
    if (this.currentShops.length === 0) { this.showError(this.t('searchError')); return; }
    document.dispatchEvent(new CustomEvent('openReservationModal', { detail: { shops: this.currentShops } }));
  }

  private toggleTTS() {
    if (!this.isUserInteracted) { this.enableAudioPlayback(); return; }
    this.enableAudioPlayback();
    this.isTTSEnabled = !this.isTTSEnabled;
    this.els.speakerBtn.innerHTML = this.isTTSEnabled ? '🔊' : '🔇';
    this.els.speakerBtn.title = this.isTTSEnabled ? this.t('btnTTSOn') : this.t('btnTTSOff');
    this.els.speakerBtn.className = this.isTTSEnabled ? 'btn btn-icon btn-speaker' : 'btn btn-icon btn-speaker disabled';
    if (!this.isTTSEnabled) this.stopCurrentAudio();
  }

  private stopAllActivities() {
    if (this.isProcessing) {
      fetch(`${this.apiBase}/api/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this.sessionId })
      }).catch(err => console.error('中止リクエスト失敗:', err));
    }
    
    this.audioManager.fullResetAudioResources();
    
    this.isRecording = false; 
    this.els.micBtn.classList.remove('recording');
    
    if (this.socket && this.socket.connected) {
        this.socket.emit('stop_stream');
    }

    this.stopCurrentAudio();
    this.hideWaitOverlay();
    this.isProcessing = false;
    this.isAISpeaking = false;
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
    this.els.userInput.value = '';
    this.els.userInput.focus();
    if (window.innerWidth < 1024) {
      setTimeout(() => { this.els.chatArea.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
    }
  }

  // --- UI ヘルパー ---

  private addMessage(role: string, text: string, summary: string | null = null, isInitial: boolean = false) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (isInitial) div.setAttribute('data-initial', 'true');
    
    let contentHtml = `<div class="message-content"><span class="message-text">${text}</span></div>`;
    if (summary) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `<div class="message-content"><span class="message-text">${text}</span></div><div class="summary-box"><strong>🔍 内容確認</strong>${summary}</div>`;
        contentHtml = wrapper.innerHTML;
    }

    div.innerHTML = `
      <div class="message-avatar">${role === 'assistant' ? '🍽' : '👤'}</div>
      ${contentHtml}
    `;
    this.els.chatArea.appendChild(div);
    this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
  }

  private resetInputState() {
    this.isProcessing = false;
    this.els.sendBtn.disabled = false;
    this.els.micBtn.disabled = false;
    this.els.userInput.disabled = false;
    this.els.userInput.focus();
  }

  private showError(msg: string) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.innerText = msg;
    this.els.chatArea.appendChild(div);
    this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
  }

  private t(key: string, ...args: any[]): string {
    // @ts-ignore
    const translation = i18n[this.currentLanguage][key];
    if (typeof translation === 'function') return translation(...args);
    return translation || key;
  }

  private updateUILanguage() {
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.userInput.placeholder = this.t('inputPlaceholder');
    this.els.micBtn.title = this.t('btnVoiceInput');
    this.els.speakerBtn.title = this.isTTSEnabled ? this.t('btnTTSOn') : this.t('btnTTSOff');
    this.els.sendBtn.textContent = this.t('btnSend');
    this.els.reservationBtn.innerHTML = this.t('btnReservation');
    
    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.innerHTML = `<img src="/pwa-152x152.png" alt="Logo" class="app-logo" /> ${this.t('pageTitle')}`;
    const pageSubtitle = document.getElementById('pageSubtitle');
    if (pageSubtitle) pageSubtitle.textContent = this.t('pageSubtitle');
    const shopListTitle = document.getElementById('shopListTitle');
    if (shopListTitle) shopListTitle.innerHTML = `🍽 ${this.t('shopListTitle')}`;
    const shopListEmpty = document.getElementById('shopListEmpty');
    if (shopListEmpty) shopListEmpty.textContent = this.t('shopListEmpty');
    const pageFooter = document.getElementById('pageFooter');
    if (pageFooter) pageFooter.innerHTML = `${this.t('footerMessage')} ✨`;

    const initialMessage = this.els.chatArea.querySelector('.message.assistant[data-initial="true"] .message-text');
    if (initialMessage) initialMessage.textContent = this.t('initialGreeting');
    
    const waitText = document.querySelector('.wait-text');
    if (waitText) waitText.textContent = this.t('waitMessage');

    document.dispatchEvent(new CustomEvent('languageChange', { detail: { language: this.currentLanguage } }));
  }
}
