// src/scripts/chat/chat-controller.ts（修正版・完全版）
import { CoreController } from './core-controller';
import { AudioManager } from './audio-manager'; 

export class ChatController extends CoreController {
  
  constructor(container: HTMLElement, apiBase: string) {
    super(container, apiBase);
    this.audioManager = new AudioManager(4500);
    // チャットモードに設定
    this.currentMode = 'chat';
    this.init();
  }

  // 初期化プロセスをオーバーライド
  protected async init() {
    // 親クラスの初期化を実行
    await super.init();
    
    // チャットモード固有の要素とイベントを追加
    const query = (sel: string) => this.container.querySelector(sel) as HTMLElement;
    this.els.modeSwitch = query('#modeSwitch') as HTMLInputElement;
    
    // モードスイッチの初期状態を設定(チャットモード = unchecked)
    if (this.els.modeSwitch) {
      this.els.modeSwitch.checked = false;
      
      // モードスイッチのイベントリスナー追加
      this.els.modeSwitch.addEventListener('change', () => {
        this.toggleMode();
      });
    }
  }

  // ★★★ 修正: モード切り替え処理の安定化 ★★★
  private toggleMode() {
    const isChecked = this.els.modeSwitch?.checked;
    if (isChecked) {
      console.log('[ChatController] Switching to Concierge mode...');
      
      // ★ ステップ1: すべての処理を停止
      this.stopAllActivities();
      
      // ★ ステップ2: 少し待ってからページ遷移（非同期処理の完了を待つ）
      setTimeout(() => {
        console.log('[ChatController] Navigating to /concierge');
        window.location.href = '/concierge';
      }, 150);
    }
    // チャットモードは既に現在のページなので何もしない
  }
}
