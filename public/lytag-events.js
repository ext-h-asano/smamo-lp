/**
 * LINEヤフー広告 イベントスニペット。
 *
 * lytag() は各 HTML の <head> にあるグローバルスニペットで定義済みなので、ここでは呼ぶだけ。
 * 送信するのはイベント種別とタグ ID のみ。個人情報 (氏名・メール・電話) は一切送らない。
 */
(function () {
    'use strict';

    var TAG_ID = 'fd83709f-6cae-4d2b-b17c-006dd993216c';
    // グローバルスニペット側と同じ条件。dev.smamo.jp でのテスト申込やテストクリックを
    // コンバージョンとして計上しない（本番の広告最適化を汚さないため）。
    var MEASURED_HOSTS = ['smamo.jp', 'www.smamo.jp'];

    function send(eventType) {
        if (MEASURED_HOSTS.indexOf(window.location.hostname) === -1) return;
        // グローバルスニペットが無いページや広告ブロッカー環境では黙って何もしない。
        if (typeof window.lytag !== 'function') return;
        window.lytag({ type: 'event', eventType: eventType, tagId: TAG_ID });
    }

    // --- 2-1. 無料体験の申込完了 (sign_up) ---------------------------------------
    // 申込完了はモーダルではなく /thankyou への遷移で表される。
    // script.js の stripe.confirmSetup({ return_url: origin + '/thankyou' }) が
    // ?setup_intent=...&redirect_status=succeeded を付けて戻してくるので、
    // 「Stripe から成功で戻ってきたとき」だけ発火させる。
    // /thankyou を直接開いた場合やブックマークでは setup_intent が無いので発火しない。
    function fireSignUpIfCompleted() {
        var params = new URLSearchParams(window.location.search);
        var setupIntent = params.get('setup_intent');
        var status = params.get('redirect_status');

        if (!setupIntent) return;                      // Stripe 経由の到達ではない
        if (status && status !== 'succeeded') return;  // 失敗して戻ってきた分は計上しない

        // リロード・戻るボタンでの二重計上を防ぐ。setup_intent は申込 1 件につき 1 つ。
        var key = 'ly_signup_' + setupIntent;
        try {
            if (sessionStorage.getItem(key)) return;
            sessionStorage.setItem(key, '1');
        } catch (e) {
            // プライベートモード等で sessionStorage が使えない場合は、
            // 取りこぼすより重複を許す方に倒す（コンバージョンの欠測を避ける）。
        }
        send('sign_up');
    }

    fireSignUpIfCompleted();

    // --- 2-2. LINE 問い合わせ (generate_lead) ------------------------------------
    // LINE ボタンは index / contact / thankyou の計 6 箇所にあり今後も増えるため、
    // 個別に onclick を書かず href で委譲する（新しいボタンを足しても自動で計測される）。
    document.addEventListener('click', function (e) {
        var target = e.target;
        if (!target || typeof target.closest !== 'function') return;   // アイコン等をクリックしても親の <a> を拾う
        var link = target.closest('a[href*="line.me"]');
        if (!link) return;
        send('generate_lead');
    }, true);
})();
