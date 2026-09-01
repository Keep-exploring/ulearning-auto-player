// ==UserScript==
// @name         优学院稳定版（AI优化）
// @namespace    fixed.autopause.enhanced
// @version      12.0
// @description  自动播放、翻页、答题，课程完成后自动暂停（增加完成计数器）
// @match        *://*.ulearning.cn/learnCourse/*
// @match        *://*.dgut.edu.cn/learnCourse/*
// @run-at       document-end
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // ========== 日志 ==========
    function log(msg) { console.log('[优学院] ' + msg); }
    function error(msg) { console.error('[优学院错误] ' + msg); }

    log('脚本开始执行...');

    // ========== 配置 ==========
    const DEFAULT_SPEED = 1.5;
    const CHECK_INTERVAL = 3000;

    let config = {
        autoPlay: true,
        autoMute: true,
        autoChangeRate: true,
        speed: DEFAULT_SPEED,
        autoFillAnswer: true,
        autoShowAnswer: true,
        autoAnswerChoices: true,
        autoAnswerJudges: true,
        autoAnswerFills: true,
    };

    // ========== 状态 ==========
    let autoAnswering = false;
    let pageId = '';
    let mainLoopTimer = null;
    let scriptPaused = false;
    let courseCompleted = false;
    let pauseBtn = null;
    let completeAttempts = 0; // 新增：完成检测计数器

    // ========== 工具 ==========
    function isVisible(el) {
        try { return el && el.offsetParent !== null; } catch(e) { return false; }
    }

    function escape2Html(str) {
        const map = { 'lt':'<', 'gt':'>', 'nbsp':' ', 'amp':'&', 'quot':'"' };
        return String(str).replace(/&(lt|gt|nbsp|amp|quot);/ig, (all,t) => map[t] || all);
    }

    function delHtmlTag(str) {
        return String(str).replace(/(<[^>]+>|\\n|\\r)/g, " ");
    }

    function groupByParent(elements) {
        const groups = [];
        let cur = [], lastParent = null;
        elements.forEach(el => {
            try {
                const parent = el.closest('.question-wrapper') || el.offsetParent;
                if (parent !== lastParent) {
                    if (cur.length) groups.push(cur);
                    cur = [];
                    lastParent = parent;
                }
                cur.push(el);
            } catch(e) { /* 忽略 */ }
        });
        if (cur.length) groups.push(cur);
        return groups;
    }

    // ========== AJAX ==========
    function fetchAnswer(questionId, pageId, retries = 3) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const url = 'https://api.ulearning.cn/questionAnswer/' + questionId + '?parentId=' + pageId;
            xhr.open('GET', url, true);
            xhr.timeout = 10000;
            xhr.onload = function() {
                if (xhr.status === 200) {
                    try {
                        const result = JSON.parse(xhr.responseText);
                        resolve(result.correctAnswerList || []);
                    } catch(e) { reject(e); }
                } else {
                    reject(new Error('HTTP ' + xhr.status));
                }
            };
            xhr.onerror = function() { reject(new Error('网络错误')); };
            xhr.ontimeout = function() { reject(new Error('超时')); };
            xhr.send();
        }).catch(err => {
            if (retries > 0) {
                return new Promise(resolve => setTimeout(resolve, 2000))
                    .then(() => fetchAnswer(questionId, pageId, retries - 1));
            }
            throw err;
        });
    }

    // ========== 翻页 ==========
    function goToNextPage() {
        try {
            if (!config.autoPlay) return;
            let nextBtn = document.querySelector('.mobile-next-page-btn');
            if (!nextBtn) {
                const allLinks = document.querySelectorAll('a, button, span, div');
                for (let el of allLinks) {
                    if (el.textContent && el.textContent.trim() === '下一页') {
                        nextBtn = el;
                        break;
                    }
                }
            }
            if (nextBtn) {
                // 按钮存在
                completeAttempts = 0; // 重置完成计数
                if (nextBtn.disabled || nextBtn.classList.contains('disabled')) {
                    log('翻页按钮不可用，可能已到最后一页');
                    markCourseComplete();
                    return;
                }
                nextBtn.click();
                log('点击下一页（' + (nextBtn.className || '文字匹配') + '）');
            } else {
                // 没有翻页按钮，增加完成计数
                completeAttempts++;
                log('未找到翻页按钮（尝试次数：' + completeAttempts + '）');
                if (completeAttempts >= 3) {
                    markCourseComplete();
                }
            }
        } catch(e) {
            error('goToNextPage异常: ' + e);
        }
    }

    // ========== 标记课程完成（自动暂停） ==========
    function markCourseComplete() {
        if (!courseCompleted) {
            courseCompleted = true;
            scriptPaused = true;
            if (pauseBtn) {
                pauseBtn.textContent = '已暂停，点击恢复';
            }
            log('课程已全部完成，脚本已自动暂停。');
            showCompleteMessage();
            // 重置计数器，防止再次触发
            completeAttempts = 0;
        }
    }

    function showCompleteMessage() {
        const oldMsg = document.getElementById('UL_CompleteMsg');
        if (oldMsg) oldMsg.remove();

        const msg = document.createElement('div');
        msg.id = 'UL_CompleteMsg';
        msg.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 20px 40px;
            border-radius: 8px;
            font-size: 20px;
            z-index: 100000;
            text-align: center;
            font-family: Arial, sans-serif;
        `;
        msg.innerHTML = `
            <div>✅ 所有课程已学习完毕！</div>
            <div style="font-size: 14px; margin-top: 10px; color: #aaa;">脚本已自动暂停，点击面板中的“恢复”可继续。</div>
        `;
        document.body.appendChild(msg);

        setTimeout(() => {
            if (msg) {
                msg.style.transition = 'opacity 1s';
                msg.style.opacity = '0';
                setTimeout(() => msg.remove(), 1500);
            }
        }, 5000);
    }

    // ========== 视频控制 ==========
    function handleVideos() {
        try {
            if (!config.autoPlay) return;
            const videos = document.querySelectorAll('mediaelementwrapper video:first-child');
            if (!videos.length) {
                // 无视频，尝试翻页
                goToNextPage();
                return;
            }

            const statusSpans = document.querySelectorAll('.video-bottom span:first-child');
            const videoArray = Array.from(videos);
            const visibleVideos = videoArray.filter(v => isVisible(v));

            if (visibleVideos.length === 0) {
                goToNextPage();
                return;
            }

            // 有可见视频，重置完成计数器
            completeAttempts = 0;

            visibleVideos.forEach((v, idx) => {
                let status = null;
                if (idx < statusSpans.length) {
                    const bindAttr = statusSpans[idx].getAttribute('data-bind');
                    if (bindAttr && bindAttr.includes('finished')) {
                        status = 'finished';
                    } else if (bindAttr && bindAttr.includes('viewed')) {
                        status = 'viewed';
                    } else if (bindAttr && bindAttr.includes('unviewed')) {
                        status = 'unviewed';
                    }
                }

                if (status === 'finished') {
                    if (!v.dataset.finished) {
                        v.dataset.finished = 'true';
                        log('平台标记已完成，跳过');
                    }
                    return;
                }

                if (!v._inited) {
                    v._inited = true;
                    if (config.autoMute) v.muted = true;
                    if (config.autoChangeRate) v.playbackRate = config.speed;

                    v.addEventListener('play', function() {
                        if (config.autoMute && !this.muted) this.muted = true;
                        if (config.autoChangeRate && this.playbackRate !== config.speed) {
                            this.playbackRate = config.speed;
                        }
                    });
                    v.addEventListener('ended', function() {
                        this.dataset.finished = 'true';
                        log('视频结束（事件）');
                    });
                    log('初始化视频');
                }

                const duration = v.duration;
                if (duration > 0 && v.currentTime >= duration - 0.5) {
                    if (!v.dataset.finished) {
                        v.dataset.finished = 'true';
                        log('视频完成（进度检测）');
                    }
                }

                if (!v.ended && !v.dataset.finished && v.paused) {
                    v.play().catch(() => {});
                }
            });

            const allFinished = visibleVideos.every(v => v.dataset.finished === 'true' || v.ended);
            if (allFinished) {
                log('所有视频已完成，准备翻页');
                goToNextPage();
            }
        } catch(e) {
            error('handleVideos异常: ' + e);
        }
    }

    // ========== 弹窗处理 ==========
    function handleModals() {
        try {
            const err = document.querySelector('.mobile-video-error');
            if (err && err.style.display !== 'none') {
                const tryAgain = err.querySelector('.try-again');
                if (tryAgain) { tryAgain.click(); log('重试错误'); }
            }
            const stat = document.getElementById('statModal');
            if (stat) {
                const btns = stat.getElementsByTagName('button');
                if (btns.length >= 2) { btns[1].click(); log('关闭statModal'); }
            }
            const alertModal = document.getElementById('alertModal');
            if (alertModal && alertModal.className.includes('in')) {
                const op = document.querySelector('.modal-operation');
                if (op) {
                    const btns = op.children;
                    if (btns.length >= 2) {
                        const idx = config.autoFillAnswer ? 0 : 1;
                        btns[idx].click();
                        log('处理alertModal');
                    } else {
                        const cont = document.querySelector('.btn-submit');
                        if (cont && cont.textContent !== '提交') {
                            cont.click();
                            log('点击继续');
                        }
                    }
                }
            }
        } catch(e) {
            error('handleModals异常: ' + e);
        }
    }

    // ========== 答题 ==========
    function handleQuestions() {
        try {
            if (!config.autoFillAnswer || autoAnswering) return;
            const qw = document.querySelectorAll('.question-wrapper');
            let hasVisible = false;
            qw.forEach(el => { if (isVisible(el)) hasVisible = true; });
            if (!hasVisible) return;
            autoAnswering = true;
            log('开始答题...');

            const pages = document.querySelectorAll('.page-item');
            let found = false;
            pages.forEach(el => {
                if (!found && el.querySelector('.page-name.active')) {
                    const id = el.id.match(/\d+/);
                    if (id) { pageId = id[0]; found = true; }
                }
            });
            if (!found) {
                autoAnswering = false;
                log('未找到页面ID');
                return;
            }

            const questionIds = [];
            qw.forEach(el => {
                if (isVisible(el)) {
                    const id = el.id.replace('question', '');
                    if (id) questionIds.push(id);
                }
            });
            if (!questionIds.length) {
                autoAnswering = false;
                return;
            }

            Promise.all(questionIds.map(qid => fetchAnswer(qid, pageId)))
                .then(answers => {
                    try {
                        if (config.autoShowAnswer) {
                            qw.forEach((el, idx) => {
                                if (idx < answers.length && answers[idx] && answers[idx].length) {
                                    const title = el.querySelector('.question-title-html');
                                    if (title) {
                                        title.insertAdjacentHTML('afterend', `<span style="color:red;">答案：${answers[idx].join(', ')}</span>`);
                                    }
                                }
                            });
                        }
                        if (config.autoAnswerChoices) {
                            const cbs = document.querySelectorAll('.checkbox');
                            const groups = groupByParent(cbs);
                            groups.forEach((group, idx) => {
                                if (idx < answers.length && answers[idx]) {
                                    answers[idx].forEach(letter => {
                                        const index = letter.charCodeAt(0) - 65;
                                        if (group[index] && !group[index].classList.contains('selected')) {
                                            group[index].click();
                                        }
                                    });
                                }
                            });
                        }
                        if (config.autoAnswerJudges) {
                            const btns = document.querySelectorAll('.choice-btn');
                            const groups = groupByParent(btns);
                            groups.forEach((group, idx) => {
                                if (idx < answers.length && answers[idx]) {
                                    answers[idx].forEach(val => {
                                        if (val.toLowerCase() === 'true') {
                                            if (group[0] && !group[0].classList.contains('selected')) group[0].click();
                                        } else {
                                            if (group[1] && !group[1].classList.contains('selected')) group[1].click();
                                        }
                                    });
                                }
                            });
                        }
                        if (config.autoAnswerFills) {
                            const textareas = document.querySelectorAll('textarea, .blank-input');
                            const flat = answers.flat();
                            textareas.forEach((el, idx) => {
                                if (idx < flat.length) {
                                    el.value = delHtmlTag(escape2Html(flat[idx]));
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                            });
                        }
                        if (config.autoPlay) {
                            const submitBtn = document.querySelector('.btn-submit');
                            if (submitBtn) { submitBtn.click(); log('提交答案'); }
                        }
                    } catch(e) {
                        error('处理答案异常: ' + e);
                    }
                    autoAnswering = false;
                })
                .catch(err => {
                    error('答题请求失败: ' + err);
                    autoAnswering = false;
                });
        } catch(e) {
            error('handleQuestions异常: ' + e);
            autoAnswering = false;
        }
    }

    // ========== 主循环 ==========
    function mainLoop() {
        if (!scriptPaused && !courseCompleted) {
            try {
                handleVideos();
                handleModals();
                handleQuestions();
            } catch(e) {
                error('主循环异常: ' + e);
            }
        }
        mainLoopTimer = setTimeout(mainLoop, CHECK_INTERVAL);
    }

    // ========== 防挂机 ==========
    function startAntiIdle() {
        setInterval(() => {
            try {
                const playing = document.querySelector('mediaelementwrapper video:not([paused])');
                if (playing) {
                    unsafeWindow.document.dispatchEvent(new Event('mousemove'));
                }
            } catch(e) { /* 忽略 */ }
        }, 5000);
    }

    // ========== 控制面板 ==========
    function buildPanel() {
        try {
            const style = document.createElement('style');
            style.textContent = `
                #UL_Panel {
                    position: fixed; top: 20px; right: 20px; z-index: 99999;
                    background: #fff; border: 2px solid #00aaff; border-radius: 8px;
                    padding: 10px 15px; box-shadow: 0 2px 12px rgba(0,0,0,0.3);
                    font-family: Arial, sans-serif; font-size: 14px;
                    max-width: 300px; opacity: 0.9; color: #333;
                }
                #UL_Panel:hover { opacity: 1; }
                #UL_Panel .title { font-weight: bold; cursor: pointer; user-select: none; }
                #UL_Panel .content { margin-top: 8px; }
                #UL_Panel label { display: block; margin: 4px 0; }
                #UL_Panel input[type="checkbox"] { margin-right: 8px; }
                #UL_Panel input[type="number"] { width: 60px; margin-left: 8px; }
                #UL_Panel .save-btn { margin-top: 8px; background: #00aaff; color: #fff; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; }
                #UL_Panel .save-btn:hover { background: #0088dd; }
                #UL_Panel .toggle-btn { float: right; cursor: pointer; color: #00aaff; }
                #UL_Panel .pause-btn { background: #ff6b6b; color: #fff; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; margin-top: 8px; }
                #UL_Panel .pause-btn:hover { background: #e55a5a; }
                .hint { color: #888; font-size: 12px; margin-left: 5px; }
            `;
            document.head.appendChild(style);

            const panel = document.createElement('div');
            panel.id = 'UL_Panel';
            panel.innerHTML = `
                <div class="title">
                    <span>优学院辅助</span>
                    <span class="toggle-btn">[收起]</span>
                </div>
                <div class="content">
                    <label><input type="checkbox" id="chkAutoPlay" checked> 自动播放/翻页</label>
                    <label><input type="checkbox" id="chkAutoMute" checked> 自动静音</label>
                    <label><input type="checkbox" id="chkAutoRate" checked> 自动调速</label>
                    <label>速率: <input type="number" id="inputSpeed" value="1.50" step="0.25" min="0.25" max="15.00"><span class="hint">最高15倍</span></label>
                    <hr>
                    <label><input type="checkbox" id="chkAutoAnswer" checked> 自动作答(总开关)</label>
                    <label style="padding-left:20px;"><input type="checkbox" id="chkShowAnswer" checked> 显示答案</label>
                    <label style="padding-left:20px;"><input type="checkbox" id="chkAnswerChoice" checked> 选择题</label>
                    <label style="padding-left:20px;"><input type="checkbox" id="chkAnswerJudge" checked> 判断题</label>
                    <label style="padding-left:20px;"><input type="checkbox" id="chkAnswerFill" checked> 填空/简答</label>
                    <button class="save-btn" id="btnSave">保存设置</button>
                    <button class="pause-btn" id="btnPause">暂停脚本</button>
                </div>
            `;
            document.body.appendChild(panel);

            pauseBtn = document.getElementById('btnPause');

            // 事件绑定
            const title = panel.querySelector('.title');
            const content = panel.querySelector('.content');
            const toggleBtn = panel.querySelector('.toggle-btn');
            let collapsed = false;
            toggleBtn.addEventListener('click', function() {
                collapsed = !collapsed;
                content.style.display = collapsed ? 'none' : 'block';
                this.textContent = collapsed ? '[展开]' : '[收起]';
            });

            pauseBtn.addEventListener('click', function() {
                scriptPaused = !scriptPaused;
                this.textContent = scriptPaused ? '已暂停，点击恢复' : '暂停脚本';
                log(scriptPaused ? '脚本已手动暂停' : '脚本已手动恢复');

                if (!scriptPaused && courseCompleted) {
                    courseCompleted = false;
                    completeAttempts = 0;
                    const msg = document.getElementById('UL_CompleteMsg');
                    if (msg) msg.remove();
                    log('重置完成状态');
                }
            });

            function loadConfig() {
                try {
                    const saved = localStorage.getItem('UL_Config');
                    if (saved) {
                        const cfg = JSON.parse(saved);
                        Object.assign(config, cfg);
                        document.getElementById('chkAutoPlay').checked = config.autoPlay;
                        document.getElementById('chkAutoMute').checked = config.autoMute;
                        document.getElementById('chkAutoRate').checked = config.autoChangeRate;
                        document.getElementById('inputSpeed').value = config.speed;
                        document.getElementById('chkAutoAnswer').checked = config.autoFillAnswer;
                        document.getElementById('chkShowAnswer').checked = config.autoShowAnswer;
                        document.getElementById('chkAnswerChoice').checked = config.autoAnswerChoices;
                        document.getElementById('chkAnswerJudge').checked = config.autoAnswerJudges;
                        document.getElementById('chkAnswerFill').checked = config.autoAnswerFills;
                    }
                } catch(e) { error('加载配置失败: ' + e); }
            }
            loadConfig();

            document.getElementById('btnSave').addEventListener('click', function() {
                try {
                    config.autoPlay = document.getElementById('chkAutoPlay').checked;
                    config.autoMute = document.getElementById('chkAutoMute').checked;
                    config.autoChangeRate = document.getElementById('chkAutoRate').checked;
                    config.speed = parseFloat(document.getElementById('inputSpeed').value) || DEFAULT_SPEED;
                    config.autoFillAnswer = document.getElementById('chkAutoAnswer').checked;
                    config.autoShowAnswer = document.getElementById('chkShowAnswer').checked;
                    config.autoAnswerChoices = document.getElementById('chkAnswerChoice').checked;
                    config.autoAnswerJudges = document.getElementById('chkAnswerJudge').checked;
                    config.autoAnswerFills = document.getElementById('chkAnswerFill').checked;
                    localStorage.setItem('UL_Config', JSON.stringify(config));
                    log('配置已保存');
                } catch(e) { error('保存配置失败: ' + e); }
            });

            document.getElementById('chkAutoAnswer').addEventListener('change', function() {
                ['chkShowAnswer','chkAnswerChoice','chkAnswerJudge','chkAnswerFill'].forEach(id => {
                    document.getElementById(id).checked = this.checked;
                });
            });
            document.getElementById('chkAutoPlay').addEventListener('change', function() {
                if (!this.checked) {
                    document.getElementById('chkAutoMute').checked = false;
                    document.getElementById('chkAutoRate').checked = false;
                } else {
                    document.getElementById('chkAutoMute').checked = true;
                    document.getElementById('chkAutoRate').checked = true;
                }
            });

            const speedInput = document.getElementById('inputSpeed');
            speedInput.addEventListener('change', function() {
                let val = parseFloat(this.value);
                if (isNaN(val)) val = DEFAULT_SPEED;
                if (val > 15) this.value = 15;
                else if (val < 0.25) this.value = 0.25;
            });

            log('控制面板加载完成');
        } catch(e) {
            error('构建面板失败: ' + e);
        }
    }

    // ========== 启动 ==========
    function init() {
        try {
            buildPanel();
            startAntiIdle();
            setTimeout(mainLoop, 2000);
            log('脚本初始化完成');
        } catch(e) {
            error('初始化失败: ' + e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
