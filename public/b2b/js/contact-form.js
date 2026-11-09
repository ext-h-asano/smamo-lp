(() => {
    const form = document.getElementById('consultationForm');
    if (!form) return;
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[role="status"]');
    let submitting = false;
    form.addEventListener('submit', (event) => {
        if (submitting) {
            event.preventDefault();
            return;
        }
        // file:// cannot reach the form endpoint. Keep entered values for a server preview.
        if (location.protocol === 'file:') {
            event.preventDefault();
            status.textContent = '送信はサーバー上でご確認ください。';
            return;
        }
        submitting = true;
        button.disabled = true;
        status.textContent = '送信しています…';
    });
    window.addEventListener('pageshow', () => {
        submitting = false;
        button.disabled = false;
        status.textContent = '';
    });
})();
