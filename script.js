// Smamo LP Full Logic
document.addEventListener('DOMContentLoaded', () => {
    // 1. Intersection Observer for Fade-In Effects
    const fadeElements = document.querySelectorAll('.fade-in, .reveal-text, .fade-simple');
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-active');
            }
        });
    }, observerOptions);
    fadeElements.forEach(el => observer.observe(el));

    // 2. Survey Carousel Logic (Patterned after Case Study)
    const surveyCarousel = document.getElementById('surveyCarousel');
    const surveySlides = document.querySelectorAll('.survey-card');
    const surveyPrevBtn = document.getElementById('surveyPrev');
    const surveyNextBtn = document.getElementById('surveyNext');
    const surveyDots = document.querySelectorAll('#surveyDots .dot');
    let currentSurveyIndex = 0;

    let sIsDragging = false;
    let sStartPosX = 0;
    let sCurrentTranslate = 0;
    let sPrevTranslate = 0;
    const sDragThreshold = 50;

    if (surveyCarousel && surveySlides.length > 0) {
        function updateSurveyCarousel() {
            const containerWidth = surveyCarousel.parentElement.offsetWidth;
            const targetSlide = surveySlides[currentSurveyIndex];
            const slideWidth = targetSlide.offsetWidth;
            const slideLeft = targetSlide.offsetLeft;

            sCurrentTranslate = (containerWidth / 2) - (slideLeft + (slideWidth / 2));
            surveyCarousel.style.transition = 'transform 0.4s cubic-bezier(0.23, 1, 0.32, 1)';
            surveyCarousel.style.transform = `translateX(${sCurrentTranslate}px)`;
            sPrevTranslate = sCurrentTranslate;

            surveySlides.forEach((slide, index) => {
                slide.classList.toggle('active', index === currentSurveyIndex);
            });
            surveyDots.forEach((dot, index) => {
                dot.classList.toggle('active', index === currentSurveyIndex);
            });
        }

        function sDragStart(e) {
            sIsDragging = true;
            sStartPosX = e.type.includes('mouse') ? e.pageX : e.touches[0].clientX;
            surveyCarousel.style.transition = 'none';
        }
        function sDragMove(e) {
            if (!sIsDragging) return;
            const currentX = e.type.includes('mouse') ? e.pageX : e.touches[0].clientX;
            const diffX = currentX - sStartPosX;
            surveyCarousel.style.transform = `translateX(${sPrevTranslate + diffX}px)`;
        }
        function sDragEnd(e) {
            if (!sIsDragging) return;
            sIsDragging = false;
            const endX = e.type.includes('mouse') ? e.pageX : (e.changedTouches ? e.changedTouches[0].clientX : sStartPosX);
            const diffX = endX - sStartPosX;
            if (diffX < -sDragThreshold) {
                currentSurveyIndex = Math.min(currentSurveyIndex + 1, surveySlides.length - 1);
            } else if (diffX > sDragThreshold) {
                currentSurveyIndex = Math.max(currentSurveyIndex - 1, 0);
            }
            updateSurveyCarousel();
        }

        surveyCarousel.addEventListener('mousedown', sDragStart);
        window.addEventListener('mousemove', sDragMove);
        window.addEventListener('mouseup', sDragEnd);
        surveyCarousel.addEventListener('touchstart', sDragStart);
        window.addEventListener('touchmove', sDragMove);
        surveyCarousel.addEventListener('touchend', sDragEnd);

        // Hover to Auto-scroll (via Zones)
        const surveyZonePrev = document.getElementById('surveyZonePrev');
        const surveyZoneNext = document.getElementById('surveyZoneNext');
        let sAutoScrollTimer;

        function sStartAutoScroll(dir) {
            if (sAutoScrollTimer) return;
            sAutoScrollTimer = setInterval(() => {
                if (dir === 'next') {
                    currentSurveyIndex = (currentSurveyIndex < surveySlides.length - 1) ? currentSurveyIndex + 1 : 0;
                } else {
                    currentSurveyIndex = (currentSurveyIndex > 0) ? currentSurveyIndex - 1 : surveySlides.length - 1;
                }
                updateSurveyCarousel();
            }, 900);
        }
        function sStopAutoScroll() {
            clearInterval(sAutoScrollTimer);
            sAutoScrollTimer = null;
        }

        // Zone Click Support
        [surveyPrevBtn, surveyZonePrev].forEach(el => el?.addEventListener('click', (e) => {
            e.stopPropagation();
            sStopAutoScroll();
            currentSurveyIndex = (currentSurveyIndex > 0) ? currentSurveyIndex - 1 : surveySlides.length - 1;
            updateSurveyCarousel();
        }));

        [surveyNextBtn, surveyZoneNext].forEach(el => el?.addEventListener('click', (e) => {
            e.stopPropagation();
            sStopAutoScroll();
            currentSurveyIndex = (currentSurveyIndex < surveySlides.length - 1) ? currentSurveyIndex + 1 : 0;
            updateSurveyCarousel();
        }));

        // Hover events for Zone
        surveyZoneNext?.addEventListener('mouseenter', () => {
            setTimeout(() => {
                if (!sAutoScrollTimer && surveyZoneNext.matches(':hover')) {
                    currentSurveyIndex = (currentSurveyIndex < surveySlides.length - 1) ? currentSurveyIndex + 1 : 0;
                    updateSurveyCarousel();
                    sStartAutoScroll('next');
                }
            }, 150);
        });
        surveyZoneNext?.addEventListener('mouseleave', sStopAutoScroll);

        surveyZonePrev?.addEventListener('mouseenter', () => {
            setTimeout(() => {
                if (!sAutoScrollTimer && surveyZonePrev.matches(':hover')) {
                    currentSurveyIndex = (currentSurveyIndex > 0) ? currentSurveyIndex - 1 : surveySlides.length - 1;
                    updateSurveyCarousel();
                    sStartAutoScroll('prev');
                }
            }, 150);
        });
        surveyZonePrev?.addEventListener('mouseleave', sStopAutoScroll);

        surveyDots.forEach((dot, index) => {
            dot.addEventListener('click', () => {
                sStopAutoScroll();
                currentSurveyIndex = index;
                updateSurveyCarousel();
            });
        });

        window.addEventListener('resize', updateSurveyCarousel);
        setTimeout(updateSurveyCarousel, 100);
    }

    // 3. Survey Section Click Logic (Auto-scroll to next section)
    const surveyCards = document.querySelectorAll('.survey-card');
    const solutionSection = document.getElementById('solution-section');
    if (surveyCards.length > 0 && solutionSection) {
        surveyCards.forEach((card) => {
            card.addEventListener('click', () => {
                solutionSection.scrollIntoView({ behavior: 'smooth' });
            });
        });
    }

    // 3. FAQ Filtering Logic
    const filterButtons = document.querySelectorAll('.faq-tab-btn');
    const faqItems = document.querySelectorAll('.faq-item');
    const faqMoreBtn = document.getElementById('faqMoreBtn');
    const faqMoreWrap = faqMoreBtn?.closest('.faq-more-wrap');
    const FAQ_INITIAL_LIMIT = 5;
    let faqExpanded = false;

    function updateFaqVisibility(filter) {
        const visibleItems = [];

        faqItems.forEach(item => {
            const category = item.dataset.category;
            const isMatch = filter === 'all' || (category && category.includes(filter));

            item.classList.toggle('hide', !isMatch);
            item.classList.remove('is-collapsed');

            if (isMatch) {
                visibleItems.push(item);
            }
        });

        if (!faqExpanded && visibleItems.length > FAQ_INITIAL_LIMIT) {
            visibleItems.slice(FAQ_INITIAL_LIMIT).forEach(item => item.classList.add('is-collapsed'));
        }

        faqMoreWrap?.classList.toggle('is-hidden', faqExpanded || visibleItems.length <= FAQ_INITIAL_LIMIT);
    }

    function applyFilter(filter) {
        updateFaqVisibility(filter);
    }
    // Initial Filter for FAQ
    const initialActive = document.querySelector('.faq-tab-btn.active');
    if (initialActive) {
        applyFilter(initialActive.dataset.filter);
    }
    filterButtons.forEach(button => {
        button.addEventListener('click', () => {
            filterButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            faqExpanded = false;
            applyFilter(button.dataset.filter);

            // Re-trigger fade effect
            faqItems.forEach(item => {
                if (!item.classList.contains('hide') && !item.classList.contains('is-collapsed')) {
                    item.style.opacity = '0';
                    setTimeout(() => { item.style.opacity = '1'; }, 10);
                }
            });
        });
    });

    faqMoreBtn?.addEventListener('click', () => {
        const activeFilter = document.querySelector('.faq-tab-btn.active')?.dataset.filter || 'all';
        faqExpanded = true;
        updateFaqVisibility(activeFilter);
    });

    // 4. Case Study Carousel Logic (Updated with Dragging)
    const carousel = document.getElementById('caseCarousel');
    const slides = document.querySelectorAll('.case-slide');
    const prevBtn = document.getElementById('casePrev');
    const nextBtn = document.getElementById('caseNext');
    const dots = document.querySelectorAll('#caseDots .dot');
    let currentCaseIndex = 0;

    let isDragging = false;
    let startPosX = 0;
    let currentTranslate = 0;
    let prevTranslate = 0;
    const dragThreshold = 70;

    if (carousel && slides.length > 0) {
        function updateCaseCarousel() {
            const containerWidth = carousel.parentElement.offsetWidth;
            const targetSlide = slides[currentCaseIndex];

            // Get the current slide's position relative to the track
            const slideWidth = targetSlide.offsetWidth;
            const slideLeft = targetSlide.offsetLeft;

            // Target: Center of the slide (slideLeft + slideWidth/2) should be at Screen Center (containerWidth/2)
            // currentTranslate = (containerWidth / 2) - (slideLeft + slideWidth / 2)
            currentTranslate = (containerWidth / 2) - (slideLeft + (slideWidth / 2));

            carousel.style.transition = 'transform 0.6s cubic-bezier(0.23, 1, 0.32, 1)';
            carousel.style.transform = `translateX(${currentTranslate}px)`;

            prevTranslate = currentTranslate;

            slides.forEach((slide, index) => {
                slide.classList.toggle('active', index === currentCaseIndex);
            });
            dots.forEach((dot, index) => {
                dot.classList.toggle('active', index === currentCaseIndex);
            });
        }

        // Drag functions
        function dragStart(e) {
            isDragging = true;
            startPosX = e.type.includes('mouse') ? e.pageX : e.touches[0].clientX;
            carousel.style.transition = 'none';
        }

        function dragMove(e) {
            if (!isDragging) return;
            const currentX = e.type.includes('mouse') ? e.pageX : e.touches[0].clientX;
            const diffX = currentX - startPosX;
            carousel.style.transform = `translateX(${prevTranslate + diffX}px)`;
        }

        function dragEnd(e) {
            if (!isDragging) return;
            isDragging = false;
            const endX = e.type.includes('mouse') ? e.pageX : (e.changedTouches ? e.changedTouches[0].clientX : startPosX);
            const diffX = endX - startPosX;

            if (diffX < -dragThreshold) {
                currentCaseIndex = Math.min(currentCaseIndex + 1, slides.length - 1);
            } else if (diffX > dragThreshold) {
                currentCaseIndex = Math.max(currentCaseIndex - 1, 0);
            }
            updateCaseCarousel();
        }

        // Event Listeners
        carousel.addEventListener('mousedown', dragStart);
        window.addEventListener('mousemove', dragMove);
        window.addEventListener('mouseup', dragEnd);
        carousel.addEventListener('touchstart', dragStart);
        window.addEventListener('touchmove', dragMove);
        window.addEventListener('touchend', dragEnd);

        // Prevent images from being dragged natively
        carousel.querySelectorAll('img').forEach(img => {
            img.addEventListener('dragstart', (e) => e.preventDefault());
        });

        // Hover to Auto-scroll (via Zones)
        const caseZonePrev = document.getElementById('caseZonePrev');
        const caseZoneNext = document.getElementById('caseZoneNext');
        let autoScrollTimer;

        function startAutoScroll(dir) {
            if (autoScrollTimer) return;
            autoScrollTimer = setInterval(() => {
                if (dir === 'next') {
                    currentCaseIndex = (currentCaseIndex < slides.length - 1) ? currentCaseIndex + 1 : 0;
                } else {
                    currentCaseIndex = (currentCaseIndex > 0) ? currentCaseIndex - 1 : slides.length - 1;
                }
                updateCaseCarousel();
            }, 1200);
        }
        function stopAutoScroll() {
            clearInterval(autoScrollTimer);
            autoScrollTimer = null;
        }

        // Zone Click Support
        [prevBtn, caseZonePrev].forEach(el => el?.addEventListener('click', (e) => {
            e.stopPropagation();
            stopAutoScroll();
            currentCaseIndex = (currentCaseIndex > 0) ? currentCaseIndex - 1 : slides.length - 1;
            updateCaseCarousel();
        }));

        [nextBtn, caseZoneNext].forEach(el => el?.addEventListener('click', (e) => {
            e.stopPropagation();
            stopAutoScroll();
            currentCaseIndex = (currentCaseIndex < slides.length - 1) ? currentCaseIndex + 1 : 0;
            updateCaseCarousel();
        }));

        // Hover events for Zone
        caseZoneNext?.addEventListener('mouseenter', () => {
            setTimeout(() => {
                if (!autoScrollTimer && caseZoneNext.matches(':hover')) {
                    currentCaseIndex = (currentCaseIndex < slides.length - 1) ? currentCaseIndex + 1 : 0;
                    updateCaseCarousel();
                    startAutoScroll('next');
                }
            }, 300);
        });
        caseZoneNext?.addEventListener('mouseleave', stopAutoScroll);

        caseZonePrev?.addEventListener('mouseenter', () => {
            setTimeout(() => {
                if (!autoScrollTimer && caseZonePrev.matches(':hover')) {
                    currentCaseIndex = (currentCaseIndex > 0) ? currentCaseIndex - 1 : slides.length - 1;
                    updateCaseCarousel();
                    startAutoScroll('prev');
                }
            }, 300);
        });
        caseZonePrev?.addEventListener('mouseleave', stopAutoScroll);

        dots.forEach((dot, index) => {
            dot.addEventListener('click', () => {
                stopAutoScroll();
                currentCaseIndex = index;
                updateCaseCarousel();
            });
        });

        window.addEventListener('resize', updateCaseCarousel);
        setTimeout(updateCaseCarousel, 100);
    }

    // 5. Modal Popup Logic + Stripe Payment Element
    const modal = document.getElementById('contactModal');
    const ctaButtons = document.querySelectorAll('a[href="#contact"], .cta-link-main[data-modal-trigger="true"]');
    const closeModal = document.getElementById('closeModal');
    const modalFormArea = document.getElementById('modalFormArea');
    const modalFormAreaStep2 = document.getElementById('modalFormAreaStep2');
    const applicationForm = document.getElementById('applicationForm');
    const applicationFormStep2 = document.getElementById('applicationFormStep2');
    const submitBtn = document.getElementById('submitBtn');
    const submitBtnStep2 = document.getElementById('submitBtnStep2');
    const smsOptionStep2 = document.getElementById('smsOptionStep2');
    const planOptionDivider = document.getElementById('planOptionDivider');
    const planOptionRow = document.getElementById('planOptionRow');
    const planSummaryTitle = document.getElementById('planSummaryTitle');
    const planSummaryPrice = document.getElementById('planSummaryPrice');
    const planSummaryUnit = document.getElementById('planSummaryUnit');
    const planSummaryRenewAmount = document.getElementById('planSummaryRenewAmount');
    const planInitialFeeRow = document.getElementById('planInitialFeeRow');
    const planInitialFeeAmount = document.getElementById('planInitialFeeAmount');
    const paymentElementContainer = document.getElementById('payment-element');
    const paymentElementError = document.getElementById('payment-element-error');
    const successMessage = document.getElementById('successMessage');
    const closeSuccessBtn = document.getElementById('closeSuccess');
    let resetModalTimer = null;

    const PLANS = {
        monthly: { title: 'スマモ 月額プラン', price: 3278, unit: '/月', hasInitFee: true, renewLabel: '/月（自動更新）' },
        yearly: { title: 'スマモ 年払いプラン', price: 32780, unit: '/年', hasInitFee: true, renewLabel: '/年（自動更新）' },
        two_year: { title: 'スマモ 2年契約プラン', price: 5478, unit: '/月', hasInitFee: false, renewLabel: '/月（2年契約・自動更新）' },
    };
    const INITIAL_FEE_TAX_INCL = 33000;
    const SMS_PRICE_TAX_INCL = 550;

    let selectedPlan = 'monthly';
    let stripe = null;
    let elements = null;
    let stripeConfigPromise = null;
    let paymentElementMounted = false;

    function formatYen(n) {
        return '¥' + n.toLocaleString('ja-JP');
    }

    function loadStripeConfig() {
        if (!stripeConfigPromise) {
            stripeConfigPromise = fetch('/api/config').then(r => r.json()).then(c => {
                if (window.Stripe && c.publishable_key) {
                    stripe = window.Stripe(c.publishable_key);
                }
                return c;
            });
        }
        return stripeConfigPromise;
    }

    function updatePlanSummaryCard() {
        const plan = PLANS[selectedPlan] || PLANS.monthly;
        if (planSummaryTitle) planSummaryTitle.textContent = plan.title;
        if (planSummaryPrice) planSummaryPrice.textContent = formatYen(plan.price);
        if (planSummaryUnit) planSummaryUnit.textContent = plan.unit;
        if (planSummaryRenewAmount) planSummaryRenewAmount.textContent = formatYen(plan.price) + plan.renewLabel;
        if (planInitialFeeRow) planInitialFeeRow.style.display = plan.hasInitFee ? 'flex' : 'none';
        if (planInitialFeeAmount) planInitialFeeAmount.textContent = formatYen(INITIAL_FEE_TAX_INCL);
        updatePlanOptionSummary();
    }

    function updatePlanOptionSummary() {
        const isChecked = Boolean(smsOptionStep2?.checked);
        if (planOptionDivider) planOptionDivider.style.display = isChecked ? 'block' : 'none';
        if (planOptionRow) planOptionRow.style.display = isChecked ? 'flex' : 'none';
    }

    // ?email=xxx で来た場合（例: アプリ「再契約」導線）にフォームへ prefill +
    // 料金プランセクションまで自動スクロール
    const urlParams = new URLSearchParams(window.location.search);
    const prefillEmail = urlParams.get('email') || '';
    if (prefillEmail) {
        window.setTimeout(() => {
            const priceSection = document.getElementById('price-section');
            if (priceSection) priceSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 500);
    }

    if (modal) {
        function openModal() {
            if (resetModalTimer) {
                clearTimeout(resetModalTimer);
                resetModalTimer = null;
            }
            updatePlanSummaryCard();
            modal.classList.add('is-active');
            document.body.style.overflow = 'hidden';
            // prefill: URL 由来のメールがあれば、毎回モーダルを開くたびに上書き反映
            if (prefillEmail) {
                const emailEl = document.getElementById('email');
                if (emailEl && !emailEl.value) emailEl.value = prefillEmail;
            }
            loadStripeConfig();
        }

        function closeModalAndReset() {
            modal.classList.remove('is-active');
            document.body.style.overflow = '';
            resetModal();
        }

        ctaButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const plan = btn.getAttribute('data-plan');
                if (plan && PLANS[plan]) selectedPlan = plan;
                openModal();
            });
        });

        closeModal?.addEventListener('click', closeModalAndReset);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModalAndReset();
        });
        closeSuccessBtn?.addEventListener('click', closeModalAndReset);

        function resetModal() {
            resetModalTimer = window.setTimeout(() => {
                if (modalFormArea) modalFormArea.style.display = 'block';
                if (modalFormAreaStep2) modalFormAreaStep2.style.display = 'none';
                if (successMessage) successMessage.style.display = 'none';
                if (submitBtn) { submitBtn.classList.remove('loading'); submitBtn.disabled = false; }
                if (submitBtnStep2) { submitBtnStep2.classList.remove('loading'); submitBtnStep2.disabled = false; }
                applicationForm?.reset();
                applicationFormStep2?.reset();
                applicationForm?.querySelectorAll('.form-group').forEach(g => g.classList.remove('has-error'));
                applicationFormStep2?.querySelectorAll('.form-group').forEach(g => g.classList.remove('has-error'));
                if (paymentElementError) {
                    paymentElementError.style.display = 'none';
                    paymentElementError.textContent = '';
                }
                if (elements) {
                    try { elements.getElement('payment')?.unmount(); } catch (_) {}
                    elements = null;
                }
                paymentElementMounted = false;
                updatePlanOptionSummary();
                resetModalTimer = null;
            }, 500);
        }

        function validateModalForm(form, termsId) {
            let isValid = true;
            const inputs = form.querySelectorAll('input[required]');
            inputs.forEach(input => {
                const group = input.closest('.form-group');
                if (!input.checkValidity()) {
                    isValid = false;
                    group?.classList.add('has-error');
                } else {
                    group?.classList.remove('has-error');
                }
            });
            if (termsId) {
                const terms = document.getElementById(termsId);
                if (terms && !terms.checked) isValid = false;
            }
            return isValid;
        }

        async function mountPaymentElement() {
            if (paymentElementMounted) return;
            await loadStripeConfig();
            if (!stripe) {
                if (paymentElementError) {
                    paymentElementError.textContent = '決済システムの読み込みに失敗しました。ページを再読み込みしてください。';
                    paymentElementError.style.display = 'block';
                }
                return;
            }
            elements = stripe.elements({
                mode: 'setup',
                currency: 'jpy',
                paymentMethodTypes: ['card'],
                appearance: { theme: 'stripe', variables: { fontFamily: 'system-ui, -apple-system, sans-serif' } },
            });
            const payment = elements.create('payment', { layout: 'tabs' });
            payment.mount('#payment-element');
            paymentElementMounted = true;
        }

        applicationForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!validateModalForm(applicationForm)) return;
            if (submitBtn) { submitBtn.classList.add('loading'); submitBtn.disabled = true; }
            // Switch to step 2 and mount Payment Element
            if (smsOptionStep2) smsOptionStep2.checked = false;
            applicationFormStep2?.reset();
            updatePlanSummaryCard();
            const emailEl = document.getElementById('email');
            const accountSuccessEmail = document.getElementById('accountSuccessEmail');
            if (accountSuccessEmail) accountSuccessEmail.textContent = `(${emailEl?.value || ''})`;
            if (modalFormArea) modalFormArea.style.display = 'none';
            if (modalFormAreaStep2) modalFormAreaStep2.style.display = 'block';
            mountPaymentElement().finally(() => {
                if (submitBtn) { submitBtn.classList.remove('loading'); submitBtn.disabled = false; }
            });
        });

        applicationFormStep2?.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!validateModalForm(applicationFormStep2, 'termsStep2')) return;
            if (!stripe || !elements) {
                if (paymentElementError) {
                    paymentElementError.textContent = '決済システムが準備できていません。少し待ってからもう一度お試しください。';
                    paymentElementError.style.display = 'block';
                }
                return;
            }
            if (paymentElementError) {
                paymentElementError.style.display = 'none';
                paymentElementError.textContent = '';
            }
            if (submitBtnStep2) { submitBtnStep2.classList.add('loading'); submitBtnStep2.disabled = true; }

            const showErr = (msg) => {
                if (paymentElementError) {
                    paymentElementError.textContent = msg;
                    paymentElementError.style.display = 'block';
                }
                if (submitBtnStep2) { submitBtnStep2.classList.remove('loading'); submitBtnStep2.disabled = false; }
            };

            try {
                const { error: submitError } = await elements.submit();
                if (submitError) {
                    showErr(submitError.message || '入力内容に誤りがあります。');
                    return;
                }

                const name = document.getElementById('name')?.value || '';
                const email = document.getElementById('email')?.value || '';
                const password = document.getElementById('password')?.value || '';
                const withSms = Boolean(smsOptionStep2?.checked);

                const resp = await fetch('/api/checkout', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ plan: selectedPlan, with_sms: withSms, email, name, password }),
                });
                const data = await resp.json();
                if (!resp.ok || !data.client_secret) {
                    showErr(data.error || '申込処理でエラーが発生しました。時間をおいて再度お試しください。');
                    return;
                }

                const { error: confirmError } = await stripe.confirmSetup({
                    elements,
                    clientSecret: data.client_secret,
                    confirmParams: {
                        return_url: window.location.origin + '/thankyou',
                        payment_method_data: {
                            billing_details: { name, email },
                        },
                    },
                });
                if (confirmError) {
                    showErr(confirmError.message || '決済の確定に失敗しました。');
                    return;
                }
            } catch (err) {
                showErr(err && err.message ? err.message : '通信エラーが発生しました。');
            }
        });

        smsOptionStep2?.addEventListener('change', updatePlanOptionSummary);
        updatePlanOptionSummary();
    }

    // 6. Dynamic Count-up for Main Visual
    const dynamicNum = document.getElementById('dynamic-num');
    if (dynamicNum) {
        const sequence = ['3', '4', '5', '6', '7', '8', '9', '∞'];
        let currentIndex = 0;

        const updateNum = () => {
            if (currentIndex < sequence.length) {
                dynamicNum.textContent = sequence[currentIndex];
                currentIndex++;

                if (currentIndex < sequence.length) {
                    // 序盤の切り替えを段階ごとに調整
                    // 2→3(1.34秒)、3→4(0.745秒)、4→5(0.52秒)、5→6(0.2秒)、6→7(0.1秒)、7→8以降(0.1秒)
                    let delay = 1340;
                    if (currentIndex === 1) {
                        delay = 745;
                    } else if (currentIndex === 2) {
                        delay = 520;
                    } else if (currentIndex === 3) {
                        delay = 200;
                    } else if (currentIndex === 4) {
                        delay = 100;
                    } else if (currentIndex >= 5) {
                        delay = 100;
                    }
                    setTimeout(updateNum, delay);
                }
            }
        };

        // Start after the initial FV entrance animation (Wait 3.5 seconds)
        setTimeout(updateNum, 3500);
    }

    // 7. Floating Button Visibility Logic
    const floatBtn = document.getElementById('floatBtn');
    const featuresSection = document.getElementById('features-section');

    if (floatBtn && featuresSection) {
        window.addEventListener('scroll', () => {
            const featuresPos = featuresSection.offsetTop - 300; // Show a bit before reaching the section
            if (window.scrollY > featuresPos) {
                floatBtn.classList.add('is-active');
            } else {
                floatBtn.classList.remove('is-active');
            }
        });

        // Smooth scroll for float button (using standard link behavior is fine but ensuring smooth)
        floatBtn.addEventListener('click', (e) => {
            const targetId = floatBtn.getAttribute('href');
            if (targetId.startsWith('#')) {
                e.preventDefault();
                const targetEl = document.querySelector(targetId);
                if (targetEl) {
                    targetEl.scrollIntoView({ behavior: 'smooth' });
                }
            }
        });
    }
    // 8. Auto-update Current Date for Status Bar
    const dateEl = document.getElementById('current-date');
    if (dateEl) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const date = now.getDate();
        dateEl.textContent = `${year}/${month}/${date}`;
    }

    // 9. Plan Toggle Logic
    const planToggle = document.getElementById('planToggle');
    const mainPrice = document.getElementById('main-price');
    const taxPrice = document.getElementById('tax-price');
    const planLabel = document.getElementById('plan-label');
    const toggleBtns = document.querySelectorAll('.toggle-btn');
    const togglePill = document.querySelector('.toggle-pill');

    if (planToggle) {
        toggleBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const plan = btn.dataset.plan;
                toggleBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                if (plan === 'yearly') {
                    togglePill.style.transform = 'translateX(100%)';
                    mainPrice.innerHTML = '¥29,800';
                    taxPrice.textContent = '※税込 32,780円';
                    planLabel.textContent = '年額';
                } else {
                    togglePill.style.transform = 'translateX(0)';
                    mainPrice.innerHTML = '¥2,980';
                    taxPrice.textContent = '※税込 3,278円';
                    planLabel.textContent = '月額';
                }
            });
        });
    }
});
