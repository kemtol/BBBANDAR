/* PomPom.ai - Centralized JavaScript with jQuery */
$(document).ready(function() {
  // ============================================================================
  // 1. SCREEN MANAGEMENT
  // ============================================================================
  const SCREENS = ['dashboard', 'paywall', 'quiz', 'sentiment', 'reveal'];
  let currentScreen = 'dashboard';

  function switchScreen(screenId) {
    if (!SCREENS.includes(screenId)) return;
    
    // Hide all screens
    $('.screen').removeClass('active');
    // Show target screen
    $(`#screen-${screenId}`).addClass('active');
    
    // Update bottom navigation (if visible)
    $('.nav-item').removeClass('active');
    $(`.nav-item[data-screen="${screenId}"]`).addClass('active');
    
    // Hide bottom nav for paywall and reveal screens
    if (screenId === 'paywall' || screenId === 'reveal') {
      $('.bottom-nav').addClass('d-none');
    } else {
      $('.bottom-nav').removeClass('d-none');
    }
    
    // Trigger screen-specific initialization
    switch (screenId) {
      case 'dashboard':
        initDashboard();
        break;
      case 'quiz':
        initQuiz();
        break;
      case 'sentiment':
        initSentiment();
        break;
      case 'reveal':
        initReveal();
        break;
    }
    
    currentScreen = screenId;
  }


  // Attach screen switching to bottom nav items
  $('.nav-item').click(function() {
    const screen = $(this).data('screen');
    switchScreen(screen);
  });

  // ============================================================================
  // 2. DASHBOARD COUNTDOWN TIMER
  // ============================================================================
  function initDashboard() {
    // Simulate countdown: 16:59:00
    let h = 16, m = 59, s = 0;
    
    function updateCountdown() {
      if (s > 0) s--;
      else if (m > 0) { m--; s = 59; }
      else if (h > 0) { h--; m = 59; s = 59; }
      
      $('#countdown-hours').text(h.toString().padStart(2, '0'));
      $('#countdown-minutes').text(m.toString().padStart(2, '0'));
      $('#countdown-seconds').text(s.toString().padStart(2, '0'));
    }
    
    // Update every second
    if (window.dashboardTimer) clearInterval(window.dashboardTimer);
    window.dashboardTimer = setInterval(updateCountdown, 1000);
    updateCountdown(); // initial call
    
    // Pulse effect for CTA
    setInterval(() => {
      $('#dashboard-cta').toggleClass('pulse');
    }, 1200);
  }

  // ============================================================================
  // 3. PAYWALL TIER SELECTION & PURCHASE
  // ============================================================================
  $('#paywall-tier-starter, #paywall-tier-pro').click(function() {
    const tier = $(this).data('tier');
    $('.paywall-tier-card').removeClass('selected');
    $(this).addClass('selected');
    $('#paywall-selected-tier').text(tier.toUpperCase());
  });

  $('#paywall-buy-btn').click(function() {
    const $btn = $(this);
    const tier = $('.paywall-tier-card.selected').data('tier') || 'pro';
    
    $btn.prop('disabled', true).text('Memproses...');
    
    // Simulate API call
    setTimeout(() => {
      $btn.text('Beli Tiket ' + tier.toUpperCase() + ' →');
      $btn.prop('disabled', false);
      // Show success screen
      $('#paywall-selection').addClass('d-none');
      $('#paywall-success').removeClass('d-none');
    }, 1800);
  });

  // ============================================================================
  // 4. QUIZ LOGIC
  // ============================================================================
  const QUIZ_QUESTIONS = [
    {
      q: "Saham dengan rasio utang/ekuitas di bawah 0.5 umumnya dianggap...",
      opts: ["Sangat berisiko", "Konservatif & sehat", "Overvalued", "Tidak likuid"],
      correct: 1,
      xp: 50,
      explain: "D/E rasio rendah artinya perusahaan tidak terlalu bergantung pada hutang. Ini sinyal kesehatan finansial jangka panjang."
    },
    {
      q: "Broker asing melakukan net buy besar di saham small-cap. Ini kemungkinan sinyal...",
      opts: ["Distribusi", "Akumulasi smart money", "Window dressing", "Panic selling"],
      correct: 1,
      xp: 75,
      explain: "Net buy broker asing di small-cap sering jadi sinyal akumulasi sebelum gerakan besar."
    },
    {
      q: "Volume anomali 3x rata-rata 20 hari tapi harga flat. Paling mungkin terjadi...",
      opts: ["Breakout gagal", "Akumulasi tersembunyi", "Likuiditas rendah", "Rights issue"],
      correct: 1,
      xp: 100,
      explain: "Volume tinggi tanpa pergerakan harga = tanda akumulasi diam-diam. Smart money masuk pelan."
    }
  ];

  let quizState = {
    currentQuestion: 0,
    score: 0,
    streak: 0,
    selectedOption: null,
    answered: false
  };

  function initQuiz() {
    // Reset state if starting fresh
    if (currentScreen !== 'quiz') return;
    renderQuizQuestion();
    updateQuizProgress();
    updateQuizScore();
  }

  function renderQuizQuestion() {
    const q = QUIZ_QUESTIONS[quizState.currentQuestion];
    $('#quiz-question-text').text(q.q);
    $('#quiz-xp').text(q.xp);
    
    const $options = $('#quiz-options');
    $options.empty();
    
    q.opts.forEach((opt, idx) => {
      const $opt = $(`
        <button class="quiz-option btn w-100 text-start p-3 mb-2 border rounded" data-index="${idx}">
          <span class="option-letter me-2">${String.fromCharCode(65 + idx)}</span>
          <span class="option-text">${opt}</span>
        </button>
      `);
      $options.append($opt);
    });
    
    // Attach click handler
    $('.quiz-option').click(function() {
      if (quizState.answered) return;
      const selected = $(this).data('index');
      quizState.selectedOption = selected;
      quizState.answered = true;
      checkAnswer();
    });
    
    // Reset explanation
    $('#quiz-explanation').addClass('d-none');
    $('#quiz-next-btn').addClass('d-none');
  }

  function checkAnswer() {
    const q = QUIZ_QUESTIONS[quizState.currentQuestion];
    const correct = q.correct;
    const selected = quizState.selectedOption;
    
    // Visual feedback
    $('.quiz-option').each(function() {
      const idx = $(this).data('index');
      $(this).removeClass('correct incorrect selected');
      if (idx === correct) $(this).addClass('correct');
      if (idx === selected && idx !== correct) $(this).addClass('incorrect');
      if (idx === selected) $(this).addClass('selected');
    });
    
    // Update score & streak
    if (selected === correct) {
      quizState.score += q.xp;
      quizState.streak++;
    } else {
      quizState.streak = 0;
    }
    
    updateQuizScore();
    
    // Show explanation
    $('#quiz-explanation-text').text(q.explain);
    $('#quiz-explanation').removeClass('d-none');
    
    // Show next button
    $('#quiz-next-btn').removeClass('d-none');
  }

  function updateQuizProgress() {
    const progress = ((quizState.currentQuestion) / QUIZ_QUESTIONS.length) * 100;
    $('#quiz-progress-bar').css('width', progress + '%');
    $('#quiz-question-counter').text(`${quizState.currentQuestion + 1}/${QUIZ_QUESTIONS.length}`);
  }

  function updateQuizScore() {
    $('#quiz-score').text('+' + quizState.score);
    if (quizState.streak > 1) {
      $('#quiz-streak').removeClass('d-none').text(`Streak ${quizState.streak}x! Bonus XP aktif`);
    } else {
      $('#quiz-streak').addClass('d-none');
    }
  }

  $('#quiz-next-btn').click(function() {
    if (quizState.currentQuestion + 1 >= QUIZ_QUESTIONS.length) {
      // End of quiz
      $('#quiz-screen').addClass('d-none');
      $('#quiz-result-screen').removeClass('d-none');
      $('#quiz-result-score').text('+' + quizState.score);
      $('#quiz-result-streak').text(quizState.streak + '🔥');
      return;
    }
    
    quizState.currentQuestion++;
    quizState.selectedOption = null;
    quizState.answered = false;
    
    renderQuizQuestion();
    updateQuizProgress();
  });

  $('#quiz-result-continue').click(function() {
    switchScreen('sentiment');
  });

  // ============================================================================
  // 5. SENTIMENT VOTING
  // ============================================================================
  const CANDIDATES = [
    { code: 'BBYB', name: 'Bank Bisnis Indonesia', sector: 'Perbankan', bull: 642, bear: 198 },
    { code: 'UCID', name: 'Uni-Charm Indonesia', sector: 'Konsumer', bull: 431, bear: 312 },
    { code: 'WIFI', name: 'Solusi Net Pratama', sector: 'Teknologi', bull: 289, bear: 401 }
  ];

  let votes = { BBYB: null, UCID: null, WIFI: null };
  let activeCandidate = 'BBYB';

  function initSentiment() {
    renderCandidateButtons();
    renderCandidateCard();
    updateBattleBar();
  }

  function renderCandidateButtons() {
    const $container = $('#sentiment-candidate-buttons');
    $container.empty();
    
    CANDIDATES.forEach(c => {
      const hasVote = votes[c.code] ? (votes[c.code] === 'bull' ? '🟢' : '🔴') : '';
      const $btn = $(`
        <button class="sentiment-candidate-btn btn flex-fill p-2 rounded" data-code="${c.code}">
          <div class="text-mono fw-bold">${c.code}</div>
          <div class="small">${hasVote}</div>
        </button>
      `);
      if (c.code === activeCandidate) $btn.addClass('active');
      $container.append($btn);
    });
    
    $('.sentiment-candidate-btn').click(function() {
      const code = $(this).data('code');
      activeCandidate = code;
      renderCandidateButtons();
      renderCandidateCard();
      updateBattleBar();
    });
  }

  function renderCandidateCard() {
    const c = CANDIDATES.find(x => x.code === activeCandidate);
    $('#sentiment-stock-code').text(c.code);
    $('#sentiment-stock-name').text(c.name);
    $('#sentiment-stock-sector').text(c.sector);
    
    const myVote = votes[activeCandidate];
    if (myVote) {
      $('#sentiment-vote-buttons').addClass('d-none');
      $('#sentiment-vote-recorded').removeClass('d-none')
        .html(`Vote lo tercatat: ${myVote === 'bull' ? '▲ BULL' : '▽ BEAR'} · Locked saat reveal`);
    } else {
      $('#sentiment-vote-buttons').removeClass('d-none');
      $('#sentiment-vote-recorded').addClass('d-none');
    }
  }

  function updateBattleBar() {
    const c = CANDIDATES.find(x => x.code === activeCandidate);
    const total = c.bull + c.bear + (votes[activeCandidate] ? 1 : 0);
    const bullPct = Math.round((c.bull + (votes[activeCandidate] === 'bull' ? 1 : 0)) / total * 100);
    const bearPct = 100 - bullPct;
    
    $('#sentiment-bull-percent').text(`▲ BULL ${bullPct}%`);
    $('#sentiment-bear-percent').text(`BEAR ${bearPct}% ▽`);
    $('#sentiment-battle-fill').css('width', bullPct + '%');
    $('#sentiment-total-votes').text(`${total} total votes · Hasil locked saat reveal`);
  }

  $('#sentiment-vote-bull').click(() => vote('bull'));
  $('#sentiment-vote-bear').click(() => vote('bear'));

  function vote(direction) {
    votes[activeCandidate] = direction;
    renderCandidateButtons();
    renderCandidateCard();
    updateBattleBar();
  }

  // ============================================================================
  // 6. REVEAL ANIMATION
  // ============================================================================
  const REVEAL_PICKS = [
    { rank: 1, code: 'BBYB', name: 'Bank Bisnis Indonesia', score: 87, bull: 76, signal: 'Strong Buy', color: 'green' },
    { rank: 2, code: 'UCID', name: 'Uni-Charm Indonesia', score: 74, bull: 58, signal: 'Buy', color: 'green' },
    { rank: 3, code: 'WIFI', name: 'Solusi Net Pratama', score: 61, bull: 42, signal: 'Watch', color: 'amber' },
    { rank: 4, code: 'BREN', name: 'Barito Renewables', score: 55, bull: 39, signal: 'Watch', color: 'amber' },
    { rank: 5, code: 'NPGF', name: 'Nusantara Properti', score: 41, bull: 31, signal: 'Neutral', color: 'muted' }
  ];

  let revealPhase = 'pre'; // pre, revealing, done
  let revealIdx = -1;

  function initReveal() {
    if (revealPhase === 'pre') {
      $('#reveal-pre').removeClass('d-none');
      $('#reveal-list').addClass('d-none');
      $('#reveal-audit').addClass('d-none');
    } else if (revealPhase === 'revealing' || revealPhase === 'done') {
      $('#reveal-pre').addClass('d-none');
      $('#reveal-list').removeClass('d-none');
      if (revealPhase === 'done') {
        $('#reveal-audit').removeClass('d-none');
      }
      renderRevealList();
    }
  }

  function startReveal() {
    revealPhase = 'revealing';
    revealIdx = -1;
    $('#reveal-pre').addClass('d-none');
    $('#reveal-list').removeClass('d-none');
    
    let i = 0;
    const interval = setInterval(() => {
      revealIdx = i;
      renderRevealList();
      i++;
      if (i >= REVEAL_PICKS.length) {
        clearInterval(interval);
        revealPhase = 'done';
        $('#reveal-audit').removeClass('d-none');
      }
    }, 700);
  }

  function renderRevealList() {
    const $container = $('#reveal-picks');
    $container.empty();
    
    REVEAL_PICKS.forEach((p, i) => {
      const revealed = i <= revealIdx;
      const $pick = $(`
        <div class="card-pompom mb-2 ${revealed ? 'revealed' : 'unrevealed'}" style="border-color: ${revealed ? `var(--color-${p.color})` : 'var(--color-border)'};">
          <div class="d-flex align-items-center gap-3">
            <div class="rank-circle ${revealed ? `bg-${p.color}-dim` : 'bg-surface'}" style="border-color: ${revealed ? `var(--color-${p.color})` : 'var(--color-border)'};">
              ${revealed ? p.rank : '?'}
            </div>
            <div class="flex-grow-1">
              <div class="d-flex align-items-center gap-2">
                <span class="text-display fs-5 ${revealed ? 'text-white' : 'text-muted'}">${p.code}</span>
                ${revealed ? `<span class="badge-pompom badge-${p.color}">${p.signal}</span>` : ''}
              </div>
              <div class="text-mono small text-muted">${revealed ? p.name : '████████'}</div>
            </div>
            ${revealed ? `
              <div class="text-end">
                <div class="text-mono fw-bold fs-6" style="color: var(--color-${p.color})">${p.score}</div>
                <div class="text-mono x-small text-muted">🟢 ${p.bull}%</div>
              </div>
            ` : ''}
          </div>
        </div>
      `);
      $container.append($pick);
    });
  }

  $('#reveal-start-btn').click(startReveal);

  // ============================================================================
  // 7. INITIALIZATION
  // ============================================================================
  // Start with dashboard
  switchScreen('dashboard');
});