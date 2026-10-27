// Smamo LP Full Logic
document.addEventListener('DOMContentLoaded', () => {
    const header = document.querySelector('.header');
    const heroSection = document.querySelector('.hero-section');

    if (header && heroSection) {
        const headerObserver = new IntersectionObserver(([entry]) => {
            header.classList.toggle('is-scrolled', !entry.isIntersecting);
        }, {
            threshold: 0
        });

        headerObserver.observe(heroSection);
    }

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

    // 3. Case Study Carousel Logic (Updated with Dragging)
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

    // 5. Modal Popup Logic
    const modal = document.getElementById('contactModal');
    const ctaButtons = document.querySelectorAll('a[href="#contact"], .cta-link-main[data-modal-trigger="true"]');
    const closeModal = document.getElementById('closeModal');
    const modalFormArea = document.getElementById('modalFormArea');
    const modalFormAreaStep2 = document.getElementById('modalFormAreaStep2');
    const applicationForm = document.getElementById('applicationForm');
    const applicationFormStep2 = document.getElementById('applicationFormStep2');
    const submitBtn = document.getElementById('submitBtn');
    const smsOptionStep2 = document.getElementById('smsOptionStep2');
    const planOptionDivider = document.getElementById('planOptionDivider');
    const planOptionRow = document.getElementById('planOptionRow');
    const successMessage = document.getElementById('successMessage');
    const closeSuccessBtn = document.getElementById('closeSuccess');
    let resetModalTimer = null;

    if (modal) {
        function openModal() {
            if (resetModalTimer) {
                clearTimeout(resetModalTimer);
                resetModalTimer = null;
            }
            modal.classList.add('is-active');
            document.body.style.overflow = 'hidden';
        }

        function closeModalAndReset() {
            modal.classList.remove('is-active');
            document.body.style.overflow = '';
            resetModal();
        }

        // Open Modal
        ctaButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                openModal();
            });
        });

        // Close Modal (Close X)
        closeModal?.addEventListener('click', closeModalAndReset);

        // Close Modal (Overlay Click)
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModalAndReset();
            }
        });

        // Close Modal (Success Message Close)
        closeSuccessBtn?.addEventListener('click', closeModalAndReset);

        function resetModal() {
            resetModalTimer = window.setTimeout(() => {
                if (modalFormArea) modalFormArea.style.display = 'block';
                if (modalFormAreaStep2) modalFormAreaStep2.style.display = 'none';
                if (successMessage) successMessage.style.display = 'none';
                if (submitBtn) {
                    submitBtn.classList.remove('loading');
                    submitBtn.disabled = false;
                }
                applicationForm?.reset();
                applicationFormStep2?.reset();
                applicationForm?.querySelectorAll('.form-group').forEach(group => group.classList.remove('has-error'));
                applicationFormStep2?.querySelectorAll('.form-group').forEach(group => group.classList.remove('has-error'));
                updatePlanOptionSummary();
                resetModalTimer = null;
            }, 500); // Wait for transition out
        }

        function updatePlanOptionSummary() {
            const isChecked = Boolean(smsOptionStep2?.checked);
            if (planOptionDivider) {
                planOptionDivider.style.display = isChecked ? 'block' : 'none';
            }
            if (planOptionRow) {
                planOptionRow.style.display = isChecked ? 'flex' : 'none';
            }
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
                if (terms && !terms.checked) {
                    isValid = false;
                }
            }

            return isValid;
        }

        applicationForm?.addEventListener('submit', (e) => {
            e.preventDefault();

            if (validateModalForm(applicationForm)) {
                if (submitBtn) {
                    submitBtn.classList.add('loading');
                    submitBtn.disabled = true;
                }

                window.setTimeout(() => {
                    if (submitBtn) {
                        submitBtn.classList.remove('loading');
                        submitBtn.disabled = false;
                    }
                    if (smsOptionStep2) {
                        smsOptionStep2.checked = false;
                    }
                    applicationFormStep2?.reset();
                    updatePlanOptionSummary();
                    if (modalFormArea) modalFormArea.style.display = 'none';
                    if (modalFormAreaStep2) modalFormAreaStep2.style.display = 'block';
                }, 3000);
            }
        });

        applicationFormStep2?.addEventListener('submit', (e) => {
            e.preventDefault();

            if (validateModalForm(applicationFormStep2, 'termsStep2')) {
                if (modalFormAreaStep2) modalFormAreaStep2.style.display = 'none';
                if (successMessage) successMessage.style.display = 'block';
            }
        });

        smsOptionStep2?.addEventListener('change', updatePlanOptionSummary);
        updatePlanOptionSummary();
    }
});

// Show the mobile CTA between the hero and consultation section.
document.addEventListener('DOMContentLoaded', () => {
    const cta = document.querySelector('.mobile-fixed-cta');
    const hero = document.querySelector('.hero-section');
    const contact = document.getElementById('contact');
    if (!cta || !hero || !contact) return;

    let pending = false;
    const update = () => {
        const visible = window.matchMedia('(max-width: 767px)').matches
            && hero.getBoundingClientRect().bottom <= 0
            && contact.getBoundingClientRect().top > window.innerHeight;
        cta.classList.toggle('is-visible', visible);
        pending = false;
    };
    const schedule = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(update);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('load', schedule);
    update();
});
