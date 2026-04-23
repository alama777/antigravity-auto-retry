# Алгоритм обработки ошибок агента (Auto-Retry Plugin)

Данный документ описывает механизм обнаружения падения агента и алгоритм принятия решений о дальнейших действиях (повторить запрос или отменить последний шаг).

Плагин использует Chrome DevTools Protocol (CDP) для подключения к веб-интерфейсу (webview) внутри среды разработки, где запущен агент, и управляет им напрямую через DOM (структуру HTML-страницы).

## 1. Обнаружение ошибки (Поиск упавшего агента)

Процесс поиска работает в фоновом режиме через периодический поллинг (опрос).
1. **Таймер опроса:** Класс `AutoRetryManager` запускает таймер со случайным интервалом, который по умолчанию срабатывает каждые 5-10 секунд (`pollIntervalMin` и `pollIntervalMax`).
2. **Получение целей (Targets):** При каждом срабатывании таймера `CDPService` запрашивает через CDP список всех доступных вкладок/webview. Он отфильтровывает ненужные системные панели и оставляет те, которые могут быть интерфейсом агента.
3. **Инъекция скрипта:** В каждую потенциальную цель плагин внедряет JavaScript-код, который выполняется прямо в контексте страницы агента.

### Детектор ошибки в DOM

Скрипт ищет на странице элементы с классом `.antigravity-agent-side-panel`. Внутри найденной панели скрипт проверяет наличие баннера с ошибкой и кнопки повтора:

```javascript
// Поиск панелей агента
const panels = Array.from(document.querySelectorAll('.antigravity-agent-side-panel'));
if (panels.length === 0) return { action: 'NOT_FOUND' };

for (const panel of panels) {
    // Поиск кнопок Retry
    const retryBtns = Array.from(panel.querySelectorAll('button')).filter(btn => btn.innerText && btn.innerText.includes('Retry'));
    // Проверка наличия текста об ошибке
    const errorBannerExists = panel.textContent.includes('Agent terminated due to error');
    
    if (!errorBannerExists || retryBtns.length === 0) {
        continue; // Панель без ошибки, проверяем следующую
    }
    // ... ошибка найдена, продолжаем алгоритм ...
}
```

Если эти условия выполнены, скрипт делает вывод, что агент упал с ошибкой, и начинает алгоритм восстановления.

---

## 2. Алгоритм обработки ошибки (Undo или Retry)

Как только ошибка обнаружена, плагин пытается определить, насколько быстро упал агент, чтобы выбрать оптимальное действие. Это делается путем парсинга времени работы агента перед падением.

### Шаг А. Определение времени работы

Скрипт находит все сообщения (шаги) чата и берет самое последнее. В тексте этого сообщения он ищет паттерн `Worked for (\d+)(s|m)` с помощью регулярного выражения.

```javascript
// Поиск блоков сообщений в чате
const chatTurns = Array.from(panel.querySelectorAll('.flex.items-start')).filter(el => {
    const text = el.textContent || '';
    if (text.includes('Ask anything') || text.includes('PlanMediaMentionsWorkflows')) return false;
    if (text.trim().length === 0) return false;
    return true;
});

let seconds = -1;

if (chatTurns.length > 0) {
    const lastTurn = chatTurns[chatTurns.length - 1];
    
    // Поиск строки "Worked for Xm/s"
    const match = (lastTurn.textContent || '').match(/Worked for (\d+)(s|m)/);
    
    if (match && match[1]) {
        const val = parseInt(match[1], 10);
        // Конвертация в секунды
        seconds = match[2] === 'm' ? val * 60 : val;
    }
}
```

### Шаг Б. Принятие решения (Порог Undo)

В настройках плагина задан параметр `undoThresholdSeconds` (по умолчанию 1 секунда).
Далее алгоритм ветвится:

#### Сценарий 1: Быстрое падение (Undo)
`Время работы <= undoThreshold`

Если агент упал почти сразу (например, из-за неверного контекста), обычный "Retry" приведет к бесконечному циклу падений на том же месте. Поэтому плагин делает **Undo** (отмену шага):

1. **Убирает баннер:** Нажимает кнопку **"Dismiss"** на баннере с ошибкой, чтобы разблокировать интерфейс.
2. **Отмена:** Нажимает найденную кнопку **"Undo"**.
3. **Подтверждение:** Нажимает кнопку **"Confirm"**.
4. **Повторная отправка:** Находит поле ввода, устанавливает фокус и нажимает кнопку **"Send"**.

```javascript
// Проверка порога (threshold)
if (seconds >= 0 && threshold > 0 && seconds <= threshold) {
    // Ищем кнопку Undo в последнем блоке
    const targetBlock = chatTurns.length > 0 ? chatTurns[chatTurns.length - 1] : panel;
    const undoButtons = Array.from(targetBlock.querySelectorAll('button, div[role="button"], span[role="button"], i, span')).filter(btn => {
        const title = (btn.getAttribute('title') || '').toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const tooltipId = (btn.getAttribute('data-tooltip-id') || '').toLowerCase();
        const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
        const cls = (btn.className || '').toString().toLowerCase();
        const txt = (btn.textContent || '').trim().toLowerCase();

        // Явно исключаем ложные срабатывания (например, кнопки Accept all / Reject all)
        if (txt.includes('accept all') || txt.includes('reject all')) return false;

        if (title.includes('undo') || ariaLabel.includes('undo') || tooltipId.includes('undo') || testId.includes('undo') || testId.includes('revert')) return true;

        if (btn.tagName.toLowerCase() === 'i' || btn.tagName.toLowerCase() === 'span') {
            if (cls.includes('undo') || cls.includes('revert')) return true;
            if (txt === 'undo' || txt === 'revert') return true;
        }
        return false;
    });

    if (undoButtons.length > 0) {
        // Закрываем баннер с ошибкой (чтобы разблокировать UI)
        const dismissBtns = Array.from(panel.querySelectorAll('button')).filter(btn => btn.innerText && btn.innerText.includes('Dismiss'));
        if (dismissBtns.length > 0) {
            robustClick(dismissBtns[dismissBtns.length - 1]);
            await sleep(300); // Даем UI время на анимацию скрытия
        }

        // Нажимаем Undo
        const lastUndoBtn = undoButtons[undoButtons.length - 1];
        robustClick(lastUndoBtn);

        // Умное ожидание и нажатие кнопки Confirm
        const getConfirmBtn = () => Array.from(document.querySelectorAll('button')).filter(btn => btn.innerText && btn.innerText.includes('Confirm')).pop();
        let confirmBtn = getConfirmBtn();
        if (!confirmBtn) {
            const startWait = Date.now();
            while (Date.now() - startWait < 2000) {
                await sleep(100);
                confirmBtn = getConfirmBtn();
                if (confirmBtn) break;
            }
        }
        if (confirmBtn) robustClick(confirmBtn);
        
        // Умное ожидание поля ввода
        let inputBox = panel.querySelector('#antigravity\\.agentSidePanelInputBox, textarea, [contenteditable="true"]');
        if (!inputBox) {
            const startWait = Date.now();
            while (Date.now() - startWait < 2000) {
                await sleep(100);
                inputBox = panel.querySelector('#antigravity\\.agentSidePanelInputBox, textarea, [contenteditable="true"]');
                if (inputBox) break;
            }
        }

        if (inputBox) {
            robustClick(inputBox);
            inputBox.focus();
            await sleep(100);

            // Поиск кнопки Send
            const possibleBtns = Array.from(panel.querySelectorAll('button, [role="button"], a, div.clickable, span.clickable')).filter(btn => {
                const title = (btn.getAttribute('title') || '').toLowerCase();
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                const cls = (btn.className || '').toString().toLowerCase();
                const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
                const txtBtn = (btn.textContent || '').trim().toLowerCase();
                
                if (txtBtn.includes('accept all') || txtBtn.includes('reject all')) return false;
                if (title.includes('send') || title.includes('submit') || aria.includes('send') || aria.includes('submit') || testId.includes('send') || testId.includes('submit') || cls.includes('send') || cls.includes('submit')) return true;
                
                const html = btn.innerHTML.toLowerCase();
                if (html.includes('codicon-send') || html.includes('codicon-arrow-right')) return true;
                return false;
            });

            const sendBtn = possibleBtns.filter(btn => btn.offsetParent !== null).pop();

            if (sendBtn) {
                robustClick(sendBtn);
            } else {
                // Фоллбэк: Эмуляция нажатия Enter
                const enterEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, keyCode: 13, key: 'Enter', code: 'Enter' });
                inputBox.dispatchEvent(enterEvent);
            }
        }
        return { action: 'RETRIED', logMsg };
    }
}
```

#### Сценарий 2: Долгое падение (Retry)
`Время работы > undoThreshold` (или время не найдено)

Если агент работал какое-то время и затем упал (например, сбой сети, ошибка LLM), скрипт просто нажимает кнопку **Retry**.

```javascript
// Если порог превышен или кнопка Undo не найдена
robustClick(retryBtn); // Нажимаем ранее найденную кнопку Retry
return { action: 'RETRIED', logMsg };
```

---

## 3. Вспомогательные функции

Для надежного взаимодействия с DOM-элементами используется функция `robustClick`, которая эмулирует полный цикл клика мышью (mousedown -> mouseup -> click), что помогает обходить некоторые защиты от программных кликов во фреймворках:

```javascript
function robustClick(el) {
    const targetWindow = el.ownerDocument.defaultView || window;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: targetWindow }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: targetWindow }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: targetWindow }));
}
```
