(() => {
  'use strict';

  const state = {questions: [], study: null, attempts: [], quiz: null, toastTimer: null};
  const byId = (id) => document.getElementById(id);
  const overlay = byId('quiz-overlay');
  const quizContent = byId('quiz-content');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  async function api(path, payload, method) {
    const options = method || (payload === undefined ? 'GET' : 'POST');
    const request = {method: options};
    if (options !== 'GET' && payload !== undefined) {
      request.headers = {'Content-Type': 'application/json'};
      request.body = JSON.stringify(payload);
    }
    if (options === 'DELETE') request.headers = {'Accept': 'application/json'};
    const response = await fetch(path, request);
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud.');
    return data;
  }

  function notify(message) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  function shuffle(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function questionsForEachArea(amount) {
    return state.study.areas.flatMap((area) => shuffle(state.questions.filter((q) => q.area === area.id)).slice(0, amount));
  }

  function areaRecord(areaName) {
    return state.study.areas.find((area) => area.id === areaName);
  }

  function renderAreaCards() {
    const latest = state.attempts[0];
    byId('stat-questions').textContent = String(state.questions.length);
    byId('area-cards').innerHTML = state.study.areas.map((area) => {
      const score = latest && latest.areas ? latest.areas[area.id] : null;
      const progress = score ? score.percent : 0;
      return '<button class="area-card" type="button" data-area="' + escapeHtml(area.id) + '" data-color="' + escapeHtml(area.color) + '">' +
        '<span class="area-icon">' + escapeHtml(area.icon) + '</span>' +
        '<h3>' + escapeHtml(area.id) + '</h3>' +
        '<p>' + escapeHtml(area.description) + '</p>' +
        '<span class="area-bottom"><small>8 preguntas · práctica</small><b>↗</b></span>' +
        '<span class="mini-progress" aria-label="Último resultado ' + progress + '%"><i style="width:' + progress + '%"></i></span>' +
        '</button>';
    }).join('');
    document.querySelectorAll('.area-card').forEach((button) => button.addEventListener('click', () => {
      const area = button.getAttribute('data-area');
      const questions = shuffle(state.questions.filter((q) => q.area === area));
      startQuiz(questions, area, 'Área: ' + area);
    }));
  }

  function renderStudy() {
    const study = state.study;
    byId('exam-summary').textContent = study.exam.summary;
    byId('exam-note').textContent = study.exam.note;
    byId('sessions').innerHTML = study.exam.sessions.map((session) => {
      const rows = session.rows.map((row) => '<div class="session-row"><span>' + escapeHtml(row[0]) + '</span><span>' + escapeHtml(row[1]) + '</span></div>').join('');
      return '<div class="session-block"><div class="session-title"><b>' + escapeHtml(session.name) + '</b><span>' + escapeHtml(session.time) + '</span></div>' + rows + '</div>';
    }).join('');

    byId('area-details').innerHTML = study.areas.map((area) => {
      const competencies = area.competencies.map((item) => '<div class="detail-area"><div class="detail-area-title"><b>' + escapeHtml(item.name) + '</b><span>' + escapeHtml(item.weight) + '%</span></div><p>' + escapeHtml(item.description) + '</p></div>').join('');
      const extras = area.components ? '<p class="detail-focus">Componentes: ' + escapeHtml(area.components.join(' · ')) + '</p>' : '';
      return '<article class="detail-area-group"><h3>' + escapeHtml(area.id) + '</h3><p>' + escapeHtml(area.description) + '</p>' + competencies + extras + '<p class="detail-focus"><b>Enfócate en:</b> ' + escapeHtml(area.focus.join(' · ')) + '</p></article>';
    }).join('');

    byId('strategies').innerHTML = study.strategies.map((item, index) => '<div class="strategy-item"><span>0' + (index + 1) + '</span><div>' + escapeHtml(item) + '</div></div>').join('');
    byId('plan').innerHTML = study.plan.map((item) => '<article class="plan-card"><small>' + escapeHtml(item.day) + '</small><b>' + escapeHtml(item.title) + '</b><p>' + escapeHtml(item.detail) + '</p></article>').join('');
    byId('resources').innerHTML = study.resources.map((item) => '<a class="resource-link" href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener noreferrer"><b>' + escapeHtml(item.title) + '</b><p>' + escapeHtml(item.detail) + '</p><span aria-hidden="true">↗</span></a>').join('');
  }

  function renderProgress() {
    const target = byId('progress-data');
    const clearButton = byId('clear-progress');
    if (!state.attempts.length) {
      clearButton.hidden = true;
      target.innerHTML = '<div class="progress-empty"><span>✳</span><b>Tu primera práctica<br>te está esperando</b><small>El historial queda guardado en este dispositivo.</small></div>';
      renderAreaCards();
      return;
    }
    clearButton.hidden = false;
    const latest = state.attempts[0];
    const averages = state.study.areas.map((area) => {
      const values = state.attempts.slice(0, 8).map((attempt) => attempt.areas && attempt.areas[area.id]).filter(Boolean);
      if (!values.length) return {area: area, percent: null};
      return {area: area, percent: Math.round(values.reduce((total, value) => total + value.percent, 0) / values.length)};
    });
    const bars = averages.map((item) => '<div class="progress-bar-row"><span>' + escapeHtml(item.area.short) + '</span><span class="progress-bar"><i style="width:' + (item.percent || 0) + '%"></i></span><b>' + (item.percent == null ? '—' : item.percent + '%') + '</b></div>').join('');
    const recent = state.attempts.slice(0, 3).map((attempt) => '<span>' + escapeHtml(attempt.mode) + ' · ' + escapeHtml(attempt.percent) + '%</span>').join('');
    target.innerHTML = '<div class="progress-summary"><div class="progress-summary-top"><small>ÚLTIMA PRÁCTICA · ' + escapeHtml(latest.mode) + '</small><b>' + escapeHtml(latest.correct) + '/' + escapeHtml(latest.total) + '</b></div><div class="progress-bars">' + bars + '</div><div class="recent-attempts">' + recent + '</div></div>';
    renderAreaCards();
  }

  function renderLearning(activeAreaId, activeTopicTitle) {
    const learning = state.study.learning;
    if (!learning || !learning.length) {
      byId('learning').innerHTML = '<div class="loading-card">La guía de temas todavía no está disponible.</div>';
      return;
    }
    const activeArea = learning.find((item) => item.area === activeAreaId) || learning[0];
    const activeTopic = activeArea.topics.find((item) => item.title === activeTopicTitle) || activeArea.topics[0];
    const tabs = learning.map((item) => '<button class="learning-area-tab' + (item.area === activeArea.area ? ' active' : '') + '" type="button" data-learning-area="' + escapeHtml(item.area) + '"><span>' + escapeHtml(item.short) + '</span></button>').join('');
    const topicList = activeArea.topics.map((topic, index) => '<button class="learning-topic' + (topic.title === activeTopic.title ? ' active' : '') + '" type="button" data-learning-topic="' + escapeHtml(topic.title) + '"><span>0' + (index + 1) + '</span><b>' + escapeHtml(topic.title) + '</b><i>→</i></button>').join('');
    const steps = activeTopic.steps.map((step, index) => '<li><span>0' + (index + 1) + '</span><p>' + escapeHtml(step) + '</p></li>').join('');
    byId('learning').innerHTML = '<aside class="learning-sidebar"><p class="mini-label">ELIGE UNA PRUEBA</p><div class="learning-tabs">' + tabs + '</div><div class="learning-topic-list">' + topicList + '</div></aside><article class="learning-detail"><div class="learning-detail-head"><div><span class="mini-label">' + escapeHtml(activeArea.short) + ' · CARTILLA</span><h3>' + escapeHtml(activeTopic.title) + '</h3></div><span class="learning-symbol">' + escapeHtml(activeArea.icon) + '</span></div><p class="learning-summary">' + escapeHtml(activeTopic.summary) + '</p><div class="learning-check"><span>QUÉ DEBES DOMINAR</span><ul>' + steps + '</ul></div><div class="learning-footer"><p><b>Señal de dominio:</b> ' + escapeHtml(activeTopic.check) + '</p><button type="button" id="practice-topic">Practicar este tema <span>↗</span></button></div></article>';
    document.querySelectorAll('[data-learning-area]').forEach((button) => button.addEventListener('click', () => {
      renderLearning(button.getAttribute('data-learning-area'), null);
    }));
    document.querySelectorAll('[data-learning-topic]').forEach((button) => button.addEventListener('click', () => {
      renderLearning(activeArea.area, button.getAttribute('data-learning-topic'));
    }));
    byId('practice-topic').addEventListener('click', () => {
      const questions = shuffle(state.questions.filter((question) => question.area === activeArea.area && question.topic === activeTopic.title));
      if (!questions.length) {
        notify('Aún no hay preguntas vinculadas a este tema.');
        return;
      }
      startQuiz(questions, activeArea.area, 'Tema: ' + activeTopic.title);
    });
  }

  function startQuiz(questions, area, mode) {
    if (!questions.length) { notify('No hay preguntas disponibles para esta práctica.'); return; }
    state.quiz = {
      questions: questions,
      index: 0,
      area: area || null,
      mode: mode,
      answers: [],
      selected: null,
      grading: false,
      startedAt: Date.now()
    };
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    renderQuestion();
  }

  function renderQuestion() {
    const quiz = state.quiz;
    const question = quiz.questions[quiz.index];
    const area = areaRecord(question.area);
    const answered = Boolean(quiz.selected);
    const feedback = quiz.selected ? '<div class="feedback-card ' + (quiz.selected.correct ? '' : 'incorrect') + '"><b>' + (quiz.selected.correct ? '¡Bien hecho! Esa es la respuesta.' : 'Vamos a revisar la idea.') + '</b><p>' + escapeHtml(quiz.selected.explanation) + '</p><small><b>Para recordar:</b> ' + escapeHtml(quiz.selected.tip) + '</small></div>' : '';
    const options = question.options.map((option) => {
      let extra = '';
      if (answered && option.key === quiz.selected.correct_answer) extra = ' correct';
      else if (answered && option.key === quiz.selected.choice && !quiz.selected.correct) extra = ' incorrect';
      return '<button class="option-button' + extra + '" type="button" data-choice="' + escapeHtml(option.key) + '" ' + (answered || quiz.grading ? 'disabled' : '') + '><span class="option-letter">' + escapeHtml(option.key) + '</span><span>' + escapeHtml(option.text) + '</span></button>';
    }).join('');
    const progress = Math.round((quiz.index / quiz.questions.length) * 100);
    quizContent.innerHTML = '<div class="quiz-progress-line"><i style="width:' + progress + '%"></i></div>' +
      '<div class="quiz-meta"><b>' + escapeHtml(area ? area.short : 'REPASO') + ' · ' + escapeHtml(question.topic) + '</b><span>' + (quiz.index + 1) + ' / ' + quiz.questions.length + '</span></div>' +
      '<h2 id="quiz-title">' + (quiz.area ? 'Práctica de ' + escapeHtml(quiz.area) : escapeHtml(quiz.mode)) + '</h2>' +
      '<p class="quiz-context">' + escapeHtml(question.prompt).replace(/\n/g, '<br>') + '</p>' +
      '<div class="quiz-meta"><span>' + escapeHtml(question.competency) + '</span><span>' + escapeHtml(question.difficulty) + '</span></div>' +
      '<div class="option-list" role="group" aria-label="Opciones de respuesta">' + options + '</div>' + feedback +
      '<div class="quiz-footer"><small>' + (answered ? 'La respuesta y su explicación ya están guardadas.' : 'Elige la respuesta que mejor resuelve la situación.') + '</small><button type="button" id="next-question" ' + (!answered ? 'disabled' : '') + '>' + (quiz.index === quiz.questions.length - 1 ? 'Ver resultados' : 'Siguiente') + ' <span aria-hidden="true">→</span></button></div>';
    document.querySelectorAll('.option-button').forEach((button) => button.addEventListener('click', () => gradeChoice(button.getAttribute('data-choice'))));
    byId('next-question').addEventListener('click', nextQuestion);
  }

  async function gradeChoice(choice) {
    const quiz = state.quiz;
    if (!quiz || quiz.selected || quiz.grading) return;
    quiz.grading = true;
    renderQuestion();
    try {
      const question = quiz.questions[quiz.index];
      const graded = await api('/api/grade', {question_id: question.id, choice: choice});
      quiz.selected = {
        question_id: question.id,
        area: question.area,
        topic: question.topic,
        prompt: question.prompt,
        choice: choice,
        correct: graded.correct,
        correct_answer: graded.correct_answer,
        explanation: graded.explanation,
        tip: graded.tip
      };
    } catch (error) {
      notify(error.message);
    }
    quiz.grading = false;
    renderQuestion();
  }

  async function nextQuestion() {
    const quiz = state.quiz;
    if (!quiz || !quiz.selected) return;
    quiz.answers.push(quiz.selected);
    quiz.index += 1;
    quiz.selected = null;
    if (quiz.index >= quiz.questions.length) {
      await finishQuiz();
      return;
    }
    renderQuestion();
  }

  function localResult(quiz) {
    const areas = {};
    let correct = 0;
    quiz.answers.forEach((answer) => {
      if (!areas[answer.area]) areas[answer.area] = {correct: 0, total: 0};
      areas[answer.area].total += 1;
      if (answer.correct) { areas[answer.area].correct += 1; correct += 1; }
    });
    Object.keys(areas).forEach((key) => { areas[key].percent = Math.round(100 * areas[key].correct / areas[key].total); });
    return {
      correct: correct,
      total: quiz.answers.length,
      percent: Math.round(100 * correct / quiz.answers.length),
      areas: areas,
      mode: quiz.mode,
      date: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - quiz.startedAt) / 1000)
    };
  }

  async function finishQuiz() {
    const quiz = state.quiz;
    const items = quiz.answers.map((answer) => ({question_id: answer.question_id, choice: answer.choice}));
    let result = localResult(quiz);
    try {
      const response = await api('/api/attempt', {
        mode: quiz.mode,
        items: items,
        duration_seconds: result.duration_seconds
      });
      result = response.result;
      state.attempts.unshift(result);
      state.attempts = state.attempts.slice(0, 20);
      renderProgress();
    } catch (error) {
      notify(error.message + ' El resultado aparece en pantalla, pero no quedó en el historial.');
    }
    renderResult(result, quiz.answers);
  }

  function renderResult(result, answers) {
    const missed = answers.filter((answer) => !answer.correct);
    const areaRows = state.study.areas.map((area) => {
      const score = result.areas && result.areas[area.id];
      if (!score) return '';
      return '<div class="result-area-row"><span>' + escapeHtml(area.short) + '</span><i><b style="width:' + score.percent + '%"></b></i><b>' + score.percent + '%</b></div>';
    }).join('');
    const review = missed.length ? missed.map((item) => {
      const correct = item.correct_answer;
      return '<div class="review-item"><b>' + escapeHtml(item.topic) + '</b><span>' + escapeHtml(item.prompt).replace(/\n/g, ' ') + '<br><span class="right-answer">Respuesta: ' + escapeHtml(correct) + '. ' + escapeHtml(item.explanation) + '</span></span></div>';
    }).join('') : '<div class="review-item"><b>¡Todas correctas!</b><span>Intenta otro recorrido para seguir fortaleciendo lo aprendido.</span></div>';
    quizContent.innerHTML = '<div class="result-top"><span class="result-spark">✳</span><h2 id="quiz-title">Terminaste esta práctica.</h2><div class="result-score">' + result.correct + ' / ' + result.total + '</div><p>' + result.percent + '% de aciertos en este ejercicio de práctica.</p></div>' +
      '<div class="result-panels"><section class="result-panel"><h3>Así te fue por área</h3>' + areaRows + '<p class="exam-note">Porcentaje de aciertos de esta práctica; no equivale al puntaje oficial Icfes.</p></section><section class="result-panel"><h3>' + (missed.length ? 'Ideas para repasar (' + missed.length + ')' : 'Revisión') + '</h3><div class="review-list">' + review + '</div></section></div>' +
      '<div class="result-actions">' + (missed.length ? '<button type="button" id="review-errors">Repasar errores</button>' : '') + '<button type="button" class="secondary" id="finish-close">Volver a la guía</button></div>';
    const close = () => closeQuiz();
    byId('finish-close').addEventListener('click', close);
    if (missed.length) byId('review-errors').addEventListener('click', () => startQuiz(missed.map((item) => state.questions.find((q) => q.id === item.question_id)).filter(Boolean), null, 'Repaso de errores'));
  }

  function closeQuiz() {
    overlay.hidden = true;
    document.body.style.overflow = '';
    state.quiz = null;
  }

  async function boot() {
    try {
      const values = await Promise.all([api('/api/questions'), api('/api/study'), api('/api/progress')]);
      state.questions = values[0].questions;
      state.study = values[1];
      state.attempts = values[2].attempts.slice().reverse();
      renderStudy();
      renderLearning();
      renderProgress();
    } catch (error) {
      byId('area-cards').innerHTML = '<div class="loading-card">No se pudo cargar el material. Comprueba que el servidor Python esté en ejecución y recarga la página.</div>';
      notify(error.message);
    }
  }

  document.querySelectorAll('.mode-card').forEach((button) => button.addEventListener('click', () => {
    const mode = button.getAttribute('data-mode');
    if (mode === 'daily') startQuiz(shuffle(questionsForEachArea(2)), null, 'Reto diario');
    if (mode === 'mock') startQuiz(shuffle(questionsForEachArea(4)), null, 'Simulacro corto');
  }));

  byId('adaptive-practice').addEventListener('click', () => {
    if (!state.study || !state.questions.length) {
      notify('Todavía no hay material disponible.');
      return;
    }
    let weakest = null;
    let weakestPercent = 101;
    state.study.areas.forEach((area) => {
      const scores = state.attempts
        .map((attempt) => attempt.areas && attempt.areas[area.id])
        .filter(Boolean)
        .slice(0, 5);
      const percent = scores.length
        ? Math.round(scores.reduce((sum, score) => sum + score.percent, 0) / scores.length)
        : 50;
      if (percent < weakestPercent) {
        weakestPercent = percent;
        weakest = area;
      }
    });
    if (!weakest) return;
    const questions = shuffle(state.questions.filter((question) => question.area === weakest.id)).slice(0, 8);
    startQuiz(questions, weakest.id, 'Práctica inteligente');
  });

  byId('clear-progress').addEventListener('click', async () => {
    if (!window.confirm('¿Quieres borrar todo el historial de prácticas guardado?')) return;
    try {
      await api('/api/progress', undefined, 'DELETE');
      state.attempts = [];
      renderProgress();
      notify('Historial eliminado.');
    } catch (error) {
      notify(error.message);
    }
  });

  byId('close-quiz').addEventListener('click', closeQuiz);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) closeQuiz(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) {
      closeQuiz();
      return;
    }
    if (!overlay.hidden && state.quiz && !state.quiz.selected && !state.quiz.grading && /^[1-4]$/.test(event.key)) {
      const button = document.querySelectorAll('.option-button')[Number(event.key) - 1];
      if (button) button.click();
    }
  });
  boot();
})();
