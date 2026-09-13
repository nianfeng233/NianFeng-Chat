/*
 * 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
 * 项目全称：念风 Chat（NianFeng-Chat）
 * 仓库：https://github.com/nianfeng233/NianFeng-Chat
 */
/**
 * V11 · composer
 * 输入区：Enter 发送 / Shift+Enter 换行、工具条、可拖拽高度、紧凑模式。
 * 只广播 message:send，不认识 chat-flow（文档 §8.1）。
 */
export const name = 'composer'
export const version = '1.0.0'
export const displayName = '输入区'
export const description = '视觉内容 · 消息输入、工具条与高度拖拽。'
export const author = '念风内核'
export const icon = '⌨️'
export const core = true
export const depends = {
  'chat-view': '^1.0.0',
  'config': '>=1.1.0',
  'event-bus': '*',
  'i18n': '>=2.0.0',
  'message-service': '^1.0.0',
  'session-service': '>=2.0.0',
  'slots': '*',
  'toast-host': '>=1.0.0',
}
export const optionalDepends = {
  'image-service': '>=1.0.0',
}
export const inject = ['slots', 'session-service', 'message-service', 'event-bus', 'toast', 'i18n', 'config', 'image-service?']
export const provides = [{ name: 'composer', type: 'singleton' }]

import { useStyle } from '../../../src/util/style.mjs'
import { COMPOSER_CSS } from './style.mjs'
import { icons } from '../../../src/util/icons.mjs'
import { compressImageFile } from '../../domain/image-service/compress.mjs'

const MIN_HEIGHT = 58

export function apply(ctx) {
  const sessions = ctx.inject('session-service')
  const messages = ctx.inject('message-service')
  const events = ctx.inject('event-bus')
  const toast = ctx.inject('toast')
  const i18n = ctx.inject('i18n')
  const config = ctx.inject('config')
  const imageService = ctx.inject('image-service?')

  useStyle(ctx, COMPOSER_CSS)

  /** conversationId -> 输入框草稿（文本 + 图片附件），切换会话时互不影响 */
  const drafts = new Map()

  ctx.slots.register('chat:composer', container => {
    container.innerHTML = `
      <div class="h-resizer" id="hResizer"></div>
      <div class="composer" id="composer">
        <div class="composer-tools">
          <span class="typing-hint" id="typingHint" hidden>正在输入…</span>
          <button class="tool-btn" title="表情（插件扩展位）" data-tool="emoji">${icons.emoji}</button>
          <button class="tool-btn" title="图片（插件扩展位）" data-tool="image">${icons.image}</button>
          <button class="tool-btn" title="附件（插件扩展位）" data-tool="file">${icons.attach}</button>
          <button class="tool-btn" title="语音输入" data-tool="voice">${icons.voice}</button>
        </div>
        <div class="composer-attachments" id="composerAttachments" hidden></div>
        <div class="composer-body">
          <textarea class="composer-input" id="composerInput"
            placeholder="${i18n.t('chat.placeholder', '输入消息，Enter 发送，Shift + Enter 换行')}"></textarea>
          <button class="stop-btn" id="stopBtn" title="停止生成">停止</button>
          <button class="send-btn" id="sendBtn"><span id="sendBtnText">${i18n.t('chat.send', '发送')}</span></button>
        </div>
        <input type="file" id="composerImageInput" accept="image/*" multiple hidden />
      </div>`

    const composer = container.querySelector('#composer')
    const input = container.querySelector('#composerInput')
    const sendBtn = container.querySelector('#sendBtn')
    const stopBtn = container.querySelector('#stopBtn')
    const typingHint = container.querySelector('#typingHint')
    const hResizer = container.querySelector('#hResizer')
    const pane = container.closest('.pane-view')
    const showTyping = on => {
      if (typingHint) typingHint.hidden = !on
    }

    /* -------- 图片附件：本地压缩成 data URL，随 message:send 一起交给模型 -------- */
    const attachmentsEl = container.querySelector('#composerAttachments')
    const imageInput = container.querySelector('#composerImageInput')
    /** @type {Array<{id?:string,dataUrl?:string,mime:string,name:string,width?:number,height?:number,size?:number,_preview?:string}>} */
    let pendingImages = []
    const previewOf = image => image?._preview || imageService?.dataUrlOf?.(image) || image?.dataUrl || ''
    const renderAttachments = () => {
      if (!attachmentsEl) return
      attachmentsEl.hidden = pendingImages.length === 0
      attachmentsEl.innerHTML = pendingImages
        .map(
          (image, index) => `
          <figure class="composer-attachment">
            <img src="${previewOf(image)}" alt="${(image.name || '图片').replace(/"/g, '')}" />
            <button type="button" title="移除图片" data-remove-image="${index}">×</button>
          </figure>`,
        )
        .join('')
    }
    const addImageFiles = async files => {
      const list = [...(files || [])].filter(file => file && /^image\//i.test(file.type || '')).slice(0, Math.max(0, 4 - pendingImages.length))
      if (!list.length) {
        if (files?.length) toast.warn('只支持图片文件，单次最多 4 张')
        return
      }
      for (const file of list) {
        try {
          const compressed = await compressImageFile(file)
          let record = {
            id: '',
            mime: compressed.mime,
            name: compressed.name,
            width: compressed.width || 0,
            height: compressed.height || 0,
            size: compressed.size || 0,
          }
          if (imageService?.saveDataUrl) {
            try {
              const saved = await imageService.saveDataUrl(compressed.dataUrl, compressed)
              if (saved?.id) record = { ...record, ...saved }
            } catch (_) {
              /* 后端不可用时保留 dataUrl 作为降级存储 */
            }
          }
          pendingImages.push({ ...record, _preview: compressed.dataUrl })
        } catch (err) {
          toast.warn(`图片处理失败：${err.message}`)
        }
      }
      renderAttachments()
    }
    const clearImages = () => {
      pendingImages = []
      renderAttachments()
      if (imageInput) imageInput.value = ''
    }
    const availableHeight = () => {
      const rect = pane.getBoundingClientRect()
      const header = pane.querySelector('.chat-header')
      return rect.height - (header?.offsetHeight || 58) - 1
    }
    const setHeight = h => {
      const avail = availableHeight()
      const maxH = Math.max(MIN_HEIGHT, avail * 0.5)
      composer.style.height = `${Math.max(MIN_HEIGHT, Math.min(h, maxH))}px`
      composer.classList.toggle('compact', composer.offsetHeight < 112)
    }

    /* -------- 发送 -------- */
    const send = () => {
      const text = input.value.replace(/\s+$/, '').replace(/^\s+/, '')
      if (!text && !pendingImages.length) return
      const convId = sessions.activeId()
      if (!convId) {
        toast.warn('请先选择一个会话')
        return
      }
      const images = pendingImages.slice(0, 4).map(image => ({
        id: image.id || '',
        mime: image.mime || '',
        name: image.name || '',
        width: image.width || 0,
        height: image.height || 0,
        size: image.size || 0,
        ...(image.id ? {} : { dataUrl: image._preview || image.dataUrl || '' }),
      }))
      input.value = ''
      clearImages()
      drafts.delete(convId)
      messages.requestSend(convId, text, images.length ? { images } : undefined) // 广播 message:send（拦截型事件）
    }

    const onKeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        send()
      }
    }
    const onClickSend = () => send()
    const showStop = on => stopBtn?.classList.toggle('show', !!on)
    const syncStop = () => showStop(!!ctx.registry.get('chat-flow')?.isRunning(sessions.activeId()))
    const onStopClick = () => {
      const convId = sessions.activeId()
      if (!convId) return
      if (ctx.registry.get('chat-flow')?.abort(convId)) showStop(false)
    }
    const onComposerClick = e => {
      const btn = e.target.closest('[data-tool]')
      if (!btn) return
      const tool = btn.dataset.tool
      ctx.emit('composer:tool', { tool, conversationId: sessions.activeId(), handled: false })
      if (tool === 'voice') {
        const result = toggleVoice()
        if (result === true) return
      }
      if (tool === 'image') {
        btn.dataset.handled = '1'
        imageInput?.click()
        return
      }
      // 表情 / 附件是插件扩展位：没有插件接管时明确说明，避免看起来像能点却没反应。
      if (!ctx.registry.get('composer-tool-host') && !btn.dataset.handled) {
        const tips = { emoji: '表情面板', image: '图片上传', file: '附件上传', voice: SpeechRecognitionCtor ? '语音输入' : '语音输入（当前浏览器不支持 Web Speech API）' }
        toast.info(`${tips[tool] || tool}是插件扩展位，当前还没有安装对应插件，可在「设置 → 插件」中查看。`)
      }
    }

    /* -------- 内置语音输入（Web Speech API） -------- */
    const SpeechRecognitionCtor = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null
    let recognition = null
    let listening = false
    let voiceBase = ''
    const voiceButton = () => container.querySelector('[data-tool="voice"]')

    const stopVoice = () => {
      try {
        recognition?.stop()
      } catch (_) {
        /* ignore */
      }
      listening = false
      voiceButton()?.classList.remove('active')
    }

    const toggleVoice = () => {
      if (!SpeechRecognitionCtor) return null
      if (listening) {
        stopVoice()
        return true
      }
      try {
        recognition = new SpeechRecognitionCtor()
        recognition.lang = navigator.language || 'zh-CN'
        recognition.interimResults = true
        recognition.continuous = false
        recognition.onstart = () => {
          listening = true
          voiceBase = input.value.trim()
          voiceButton()?.classList.add('active')
        }
        recognition.onresult = event => {
          let finalText = ''
          let interimText = ''
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const chunk = event.results[i][0]?.transcript || ''
            if (event.results[i].isFinal) finalText += chunk
            else interimText += chunk
          }
          const combined = (finalText || interimText).trim()
          input.value = (voiceBase ? voiceBase + ' ' : '') + combined
        }
        recognition.onerror = event => {
          listening = false
          voiceButton()?.classList.remove('active')
          if (event.error !== 'aborted' && event.error !== 'no-speech') toast.error(`语音识别失败：${event.error}`)
        }
        recognition.onend = () => {
          listening = false
          voiceButton()?.classList.remove('active')
          input.focus()
        }
        recognition.start()
        return true
      } catch (err) {
        toast.error(`无法启动语音输入：${err.message}`)
        return true
      }
    }

    input.addEventListener('keydown', onKeydown)
    sendBtn.addEventListener('click', onClickSend)
    stopBtn?.addEventListener('click', onStopClick)
    composer.addEventListener('click', onComposerClick)

    /* -------- 图片：选择 / 粘贴 / 拖拽 / 移除 -------- */
    const onImagePicked = () => {
      addImageFiles(imageInput?.files).catch(() => {})
      if (imageInput) imageInput.value = ''
    }
    const onAttachmentClick = event => {
      const button = event.target.closest?.('[data-remove-image]')
      if (!button) return
      const index = Number(button.dataset.removeImage)
      if (Number.isFinite(index)) {
        pendingImages.splice(index, 1)
        renderAttachments()
      }
    }
    const onPaste = event => {
      const files = [...(event.clipboardData?.files || [])]
      if (files.some(file => /^image\//i.test(file.type || ''))) {
        event.preventDefault()
        addImageFiles(files).catch(() => {})
      }
    }
    const onDragOver = event => {
      if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault()
    }
    const onDrop = event => {
      const files = [...(event.dataTransfer?.files || [])]
      if (files.some(file => /^image\//i.test(file.type || ''))) {
        event.preventDefault()
        addImageFiles(files).catch(() => {})
      }
    }
    imageInput?.addEventListener('change', onImagePicked)
    attachmentsEl?.addEventListener('click', onAttachmentClick)
    input.addEventListener('paste', onPaste)
    composer.addEventListener('dragover', onDragOver)
    composer.addEventListener('drop', onDrop)

    /* -------- 高度拖拽 -------- */
    let dragging = false
    const onResizeDown = e => {
      dragging = true
      hResizer.classList.add('dragging')
      document.body.classList.add('resizing-h')
      e.preventDefault()
    }
    const onResizeMove = e => {
      if (!dragging) return
      const rect = pane.getBoundingClientRect()
      setHeight(rect.bottom - e.clientY)
    }
    const onResizeUp = () => {
      if (!dragging) return
      dragging = false
      hResizer.classList.remove('dragging')
      document.body.classList.remove('resizing-h')
      config.set('chat.composerHeight', Math.round(composer.offsetHeight))
    }
    let heightApplied = false
    const savedHeight = () => {
      const value = Number(config.get('chat.composerHeight', 0))
      return Number.isFinite(value) && value > 0 ? value : 0
    }
    const applySavedLayout = () => {
      if (dragging) return
      const avail = availableHeight()
      const saved = savedHeight()
      // 刚挂载时 pane 可能还没完成布局，高度为 0；等有真实高度再应用，
      // 否则保存的高度会被 maxH 夹到最小高度，看起来像“重启后恢复默认”。
      if (!Number.isFinite(avail) || avail < MIN_HEIGHT * 2) {
        // 已经明确保存过高度时，先按像素原样放回（不做 maxH 夹取），
        // 等拿到真实可用高度后的定时器再做范围校正。
        if (saved) {
          composer.style.height = `${Math.max(MIN_HEIGHT, Math.round(saved))}px`
          heightApplied = true
        }
        return
      }
      if (saved) {
        setHeight(saved)
        heightApplied = true
        return
      }
      if (heightApplied) return
      heightApplied = true
      setHeight(Math.max(MIN_HEIGHT, avail * 0.36))
    }
    // 后端偏好同步可能晚于插件挂载（换端口 / 换 origin / 重装后首次启动）：
    // 保存的高度到账时立即补应用，否则会一直停留在插件挂载时的默认高度。
    const offComposerConfig = config.watch('chat.composerHeight', () => {
      if (dragging) return
      const saved = savedHeight()
      if (!saved) {
        if (!heightApplied) applySavedLayout()
        return
      }
      const avail = availableHeight()
      // 插件挂载瞬间 pane 可能还没有实际高度，此时 setHeight 会把保存值
      // 夹到最小高度并误标记“已应用”；先按像素原样放回，等布局完成再校正。
      if (!Number.isFinite(avail) || avail < MIN_HEIGHT * 2) {
        composer.style.height = `${Math.max(MIN_HEIGHT, Math.round(saved))}px`
        heightApplied = true
        return
      }
      setHeight(saved)
      heightApplied = true
    })
    const onWindowResize = () => {
      const saved = savedHeight()
      if (saved) {
        setHeight(saved)
        heightApplied = true
        return
      }
      if (heightApplied) setHeight(composer.offsetHeight)
      else applySavedLayout()
    }

    hResizer.addEventListener('mousedown', onResizeDown)
    window.addEventListener('mousemove', onResizeMove)
    window.addEventListener('mouseup', onResizeUp)
    window.addEventListener('resize', onWindowResize)

    applySavedLayout()
    const initTimer = setTimeout(applySavedLayout, 50)
    const initTimer2 = setTimeout(applySavedLayout, 300)
    let rafTimer = null
    if (typeof requestAnimationFrame === 'function') rafTimer = requestAnimationFrame(applySavedLayout)

    const offI18n = ctx.on('i18n:changed', () => {
      const t = ctx.registry.get('i18n')
      input.placeholder = t?.t('chat.placeholder', input.placeholder) || input.placeholder
      const sendText = container.querySelector('#sendBtnText')
      if (sendText) sendText.textContent = t?.t('chat.send', '发送') || '发送'
    })

    let currentConvId = sessions.activeId()
    const saveDraft = conversationId => {
      if (!conversationId) return
      drafts.set(conversationId, { text: input.value, images: pendingImages.slice() })
    }
    const loadDraft = conversationId => {
      const draft = conversationId ? drafts.get(conversationId) : null
      input.value = draft?.text || ''
      pendingImages = Array.isArray(draft?.images) ? draft.images.slice() : []
      renderAttachments()
    }
    loadDraft(currentConvId)

    const onConversationSwitch = (payload = {}) => {
      saveDraft(currentConvId)
      currentConvId = payload?.id ?? sessions.activeId()
      input.disabled = false
      loadDraft(currentConvId)
      showTyping(false)
      syncStop()
      setTimeout(() => input.focus(), 10)
    }
    const offSwitch = events.on('conversation:switch', onConversationSwitch)
    const offStart = events.on('chat:request-start', ({ conversationId } = {}) => {
      if (conversationId === sessions.activeId()) showStop(true)
    })
    const offDone = events.on('chat:request-done', ({ conversationId } = {}) => {
      if (conversationId === sessions.activeId()) {
        showStop(false)
        showTyping(false)
      }
    })
    const offError = events.on('message:error', ({ conversationId } = {}) => {
      if (conversationId === sessions.activeId()) {
        showStop(false)
        showTyping(false)
      }
    })
    // 工具发送消息前的“真人打字”状态（chat-tools 广播）
    const offTyping = events.on('chat:typing', ({ conversationId, typing } = {}) => {
      if (conversationId === sessions.activeId()) showTyping(typing !== false)
    })

    return () => {
      clearTimeout(initTimer)
      clearTimeout(initTimer2)
      if (rafTimer !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafTimer)
      offComposerConfig()
      stopVoice()
      input.removeEventListener('keydown', onKeydown)
      sendBtn.removeEventListener('click', onClickSend)
      stopBtn?.removeEventListener('click', onStopClick)
      composer.removeEventListener('click', onComposerClick)
      imageInput?.removeEventListener('change', onImagePicked)
      attachmentsEl?.removeEventListener('click', onAttachmentClick)
      input.removeEventListener('paste', onPaste)
      composer.removeEventListener('dragover', onDragOver)
      composer.removeEventListener('drop', onDrop)
      hResizer.removeEventListener('mousedown', onResizeDown)
      window.removeEventListener('mousemove', onResizeMove)
      window.removeEventListener('mouseup', onResizeUp)
      window.removeEventListener('resize', onWindowResize)
      offI18n()
      offSwitch()
      offStart()
      offDone()
      offError()
      offTyping()
      container.innerHTML = ''
    }
  })

  ctx.provide('composer', {
    name: 'composer',
    focus: () => document.querySelector('#composerInput')?.focus(),
  }, { type: 'singleton' })

  ctx.logger.debug('输入区就绪')
}
