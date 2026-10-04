// Adapted from Codex Remote Bridge, MIT; see remote_ui/LICENSE.
(async () => {
    const protocol = 1;
    const globalName = "__LANPOWER_GLOBAL__";
    const bindingName = "__LANPOWER_BINDING__";
    const notificationMethods = ["error","account/rateLimits/updated","thread/started","thread/archived","thread/unarchived","thread/queue/changed","thread/name/updated","thread/settings/updated","thread/status/changed","thread/tokenUsage/updated","turn/started","turn/completed","turn/diff/updated","turn/plan/updated","item/started","item/completed","item/agentMessage/delta","item/plan/delta","item/reasoning/summaryTextDelta","item/commandExecution/outputDelta","item/commandExecution/terminalInteraction","item/fileChange/outputDelta","item/fileChange/patchUpdated","serverRequest/resolved"];
    const root = globalThis.__codexRoot && globalThis.__codexRoot._internalRoot
      ? globalThis.__codexRoot._internalRoot.current
      : null;
    if (!root) throw new Error('Codex renderer React root is unavailable.');

    const isManager = (value) => {
      if (!value || typeof value !== 'object') return false;
      const required = [
        'getHostId',
        'getConversation',
        'sendRequest',
        'addApprovalRequestListener',
        'addNotificationCallback',
        'addTurnCompletedListener',
        'addStreamRoleStateCallback'
      ];
      return required.every((key) => typeof value[key] === 'function');
    };
    const stack = [root];
    const seen = new Set();
    let manager = null;
    while (stack.length > 0) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 160; index += 1, hook = hook.next) {
        const candidate = hook.memoizedState;
        if (!isManager(candidate)) continue;
        let hostId = null;
        try { hostId = candidate.getHostId(); } catch {}
        if (hostId === 'local') {
          manager = candidate;
          break;
        }
      }
      if (manager) break;
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    if (!manager || manager.getHostId() !== 'local') {
      throw new Error('Codex local AppServerManager was not found.');
    }

    const previous = globalThis[globalName];
    if (previous && typeof previous.dispose === 'function') previous.dispose();

    let sequence = 0;
    let disposed = false;
    const disposers = [];
    const pendingServerRequests = new Map();
    const respondingServerRequestIds = new Set();
    const desktopResolvedDuringResponseIds = new Set();
    const historyItems = new Map();
    let historyCharacters = 0;
    const trimHistoryBodies = keep => {
      for (const [key, entry] of historyItems) {
        if (historyCharacters * 2 <= 64 * 1024 * 1024) break;
        if (key === keep || !entry.body) continue;
        historyCharacters -= entry.body.length; entry.body = null;
      }
    };
    const fingerprint = async body => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))), b => b.toString(16).padStart(2, '0')).join('');
    const storeHistory = async (threadId, turnId, item, itemIndex, cursor, wholeTurn = false) => {
      const body = JSON.stringify(item);
      if (body.length * 2 > 64 * 1024 * 1024) throw new Error('history_item_too_large');
      for (const [key, entry] of historyItems) {
        if (Date.now() - entry.time > 600000) { historyCharacters -= entry.body?.length || 0; historyItems.delete(key); }
      }
      const imagePaths = new Set();
      const addPath = value => { if (typeof value === 'string' && imagePaths.size < 1024 && /^(?:[A-Za-z]:[\\/]|\/|file:)/i.test(value)) imagePaths.add(value); };
      const observeImages = (value, key) => {
        if (Array.isArray(value)) { for (const part of value) observeImages(part,key); }
        else if (value && typeof value === 'object') { for (const [name,part] of Object.entries(value)) observeImages(part,name); }
        else if (typeof value === 'string') {
          if (['url','path','image_path','imagePath','image_url','imageUrl','localImage','savedPath'].includes(key)) addPath(value);
          if (['text','message','output'].includes(key)) {
            for (const match of value.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\r\n)]+))\)/g)) addPath(match[1] || match[2]);
          }
        }
      };
      observeImages(item);
      const descriptor = reference => ({ id: item.id, type: 'lanpowerLargeItem', originalType: wholeTurn ? 'turn' : item.type,
        reference, characters: body.length, bytes: new TextEncoder().encode(body).length, wholeTurn, leaseSeconds:600,
        ...(imagePaths.size ? {imageReferences:Array.from(imagePaths,path => ({path}))} : {}) });
      const hash = await fingerprint(body);
      for (const [reference, entry] of historyItems) {
        if (entry.threadId === threadId && entry.turnId === turnId && entry.itemIndex === itemIndex && entry.wholeTurn === wholeTurn && entry.hash === hash) {
          entry.time = Date.now(); return descriptor(reference);
        }
      }
      if (historyItems.size >= 4096) throw new Error('history_cache_busy');
      const reference = 'native-' + (++sequence) + '-' + Math.random().toString(36).slice(2);
      historyItems.set(reference, { threadId, turnId, itemId:item.id, itemIndex, cursor, wholeTurn, hash, body, time: Date.now() });
      historyCharacters += body.length; trimHistoryBodies(reference);
      return descriptor(reference);
    };
    const publicPayload = value => {
      if (Array.isArray(value)) return value.map(publicPayload);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => !['encryptedContent','encrypted_content','reasoningContent','reasoning_content'].includes(key)
        && !(value.type === 'reasoning' && key === 'content') && !(value.type === 'contextCompaction' && !['id','type','status'].includes(key))).map(([key,part]) => [key,publicPayload(part)]));
    };
    const publicTurn = turn => ({ ...publicPayload(turn), items: (turn.items || []).map(publicPayload) });
    const packTurn = async (threadId, turn, cursor) => {
      const visible = publicTurn(turn);
      const items = [];
      for (const [index, item] of visible.items.entries()) items.push(JSON.stringify(item).length > 128 * 1024
        ? await storeHistory(threadId, turn.id, item, index, cursor) : item);
      const packed = { ...visible, items };
      if (JSON.stringify(packed).length > 2 * 1024 * 1024)
        return { ...visible, items: [await storeHistory(threadId, turn.id, visible, -1, cursor, true)] };
      return packed;
    };
    const rehydrateHistory = async entry => {
      let cursor = entry.cursor, retryFromTail = Boolean(cursor);
      const seen = new Set();
      while (true) {
        const page = await manager.sendRequest('thread/turns/list', {threadId:entry.threadId,limit:8,itemsView:'full',sortDirection:'desc',...(cursor ? {cursor} : {})}, {priority:'critical'});
        const turn = (page.data || []).find(turn => turn.id === entry.turnId);
        if (turn) {
          const visible = publicTurn(turn), item = entry.wholeTurn ? visible : visible.items[entry.itemIndex];
          if (!item || item.id !== entry.itemId) throw new Error('history_reference_changed');
          const body = JSON.stringify(item);
          if (await fingerprint(body) !== entry.hash) throw new Error('history_reference_changed');
          return body;
        }
        if (retryFromTail) { cursor = undefined; retryFromTail = false; continue; }
        if (!page.nextCursor) throw new Error('history_reference_changed');
        if (seen.has(page.nextCursor)) throw new Error('invalid_history_cursor');
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
    };
    const emit = (kind, payload) => {
      if (disposed) return;
      const binding = globalThis[bindingName];
      if (typeof binding !== 'function') return;
      try {
        let visible = publicPayload(payload);
        // Large events are hints; full bodies remain in the native history and its bounded cache.
        if (kind === 'notification' && JSON.stringify(visible).length > 128 * 1024) {
          const p = visible.params || {}, threadId = p.threadId || p.thread?.id;
          visible = visible.method === 'turn/completed' || visible.method === 'turn/started'
            ? { ...visible, params: { ...p, turn: { ...p.turn, items: [] } } }
            : { method: 'lanpower/historyChanged', params: { threadId } };
        }
        binding(JSON.stringify({ protocol, kind, sequence: ++sequence, payload: visible }));
      } catch {}
    };
    const addDisposer = (value) => {
      if (typeof value === 'function') disposers.push(value);
    };
    const readRequestId = (value) => {
      const id = value && typeof value === 'object'
        ? (value.id ?? value.requestId ?? value.request_id)
        : null;
      return Number.isSafeInteger(id) && id >= 0 ? id : null;
    };
    const approvalMethodByKind = {
      commandExecution: 'item/commandExecution/requestApproval',
      fileChange: 'item/fileChange/requestApproval',
      permissionRequest: 'item/permissions/requestApproval',
      userInput: 'item/tool/requestUserInput',
      mcpElicitation: 'mcpServer/elicitation/request'
    };
    const approvalKindByMethod = Object.fromEntries(
      Object.entries(approvalMethodByKind).map(([kind, method]) => [method, kind])
    );
    const captureApprovalRequest = (event) => {
      if (!event || typeof event !== 'object') return;
      const id = readRequestId(event);
      const conversationId = typeof event.conversationId === 'string' ? event.conversationId.trim() : '';
      if (id === null || !conversationId) return;
      let conversation = null;
      try { conversation = manager.getConversation(conversationId); } catch {}
      const requests = conversation && Array.isArray(conversation.requests) ? conversation.requests : [];
      const request = requests.find((candidate) => readRequestId(candidate) === id) ?? null;
      const method = request && typeof request.method === 'string'
        ? request.method.trim()
        : (approvalMethodByKind[event.kind] ?? '');
      if (id === null || !method) return;
      const pending = {
        id,
        method,
        conversationId,
        params: request && Object.prototype.hasOwnProperty.call(request, 'params')
          ? request.params
          : { threadId: conversationId, reason: event.reason ?? null },
        receivedAtIso: new Date().toISOString()
      };
      pendingServerRequests.set(id, pending);
      emit('notification', { method: 'server/request', params: pending });
    };
    addDisposer(manager.addApprovalRequestListener(captureApprovalRequest));
    if (typeof manager.addUserInputRequestListener === 'function') {
      addDisposer(manager.addUserInputRequestListener(event => captureApprovalRequest({ ...event, kind: 'userInput' })));
    }
    if (typeof manager.getRecentConversations === 'function') {
      let recentConversations = [];
      try { recentConversations = manager.getRecentConversations() ?? []; } catch {}
      for (const summary of recentConversations) {
        const conversationId = summary && typeof summary.id === 'string' ? summary.id.trim() : '';
        if (!conversationId) continue;
        let conversation = null;
        try { conversation = manager.getConversation(conversationId); } catch {}
        const requests = conversation && Array.isArray(conversation.requests) ? conversation.requests : [];
        for (const request of requests) {
          const id = readRequestId(request);
          const method = request && typeof request.method === 'string' ? request.method.trim() : '';
          const kind = approvalKindByMethod[method];
          if (id === null || !kind) continue;
          captureApprovalRequest({ conversationId, requestId: id, kind });
        }
      }
    }
    const isMissingRolloutError = (error) => {
      let current = error;
      for (let depth = 0; current && depth < 4; depth += 1) {
        const text = current instanceof Error ? current.message : String(current);
        if (text.toLowerCase().includes('no rollout found for thread id')) return true;
        current = current && typeof current === 'object' ? current.cause : null;
      }
      return false;
    };
    addDisposer(manager.addNotificationCallback(notificationMethods, (event) => {
      if (event && event.method === 'serverRequest/resolved') {
        const id = readRequestId(event.params);
        const wasPending = id !== null && pendingServerRequests.delete(id);
        const isResponding = id !== null && respondingServerRequestIds.has(id);
        if (id !== null && isResponding) desktopResolvedDuringResponseIds.add(id);
        if (id !== null && (wasPending || isResponding)) {
          emit('notification', {
            method: 'server/request/resolved',
            params: { id, mode: 'desktop', resolvedAtIso: new Date().toISOString() }
          });
        }
      }
      emit('notification', event);
    }));
    addDisposer(manager.addTurnCompletedListener((event) => {
      emit('turnCompleted', event);
    }));
    addDisposer(manager.addStreamRoleStateCallback((threadId, state) => {
      emit('streamRole', { threadId, state });
    }));
    if (typeof manager.addConversationStateCallback === 'function') {
      addDisposer(manager.addConversationStateCallback((threadId, state) => {
        emit('conversationState', {
          threadId,
          active: typeof manager.isConversationStreaming === 'function'
            ? manager.isConversationStreaming(threadId)
            : null,
          runtimeStatus: state && state.threadRuntimeStatus ? state.threadRuntimeStatus : null,
          updatedAt: state && typeof state.updatedAt === 'number' ? state.updatedAt : null
        });
      }));
    }

    const adapter = {
      protocol,
      manager,
      async startTurn(params) {
        if (!params || typeof params !== 'object') throw new Error('turn/start params are required.');
        const threadId = typeof params.threadId === 'string' ? params.threadId.trim() : '';
        if (!threadId) throw new Error('turn/start requires threadId.');
        // The renderer cache can outlive the local app-server process. Resume
        // unconditionally so turn/start always targets a live Desktop thread.
        try {
          await manager.sendRequest('thread/resume', { threadId }, { priority: 'critical' });
        } catch (error) {
          if (!isMissingRolloutError(error)) throw error;
        }
        // Native desktop tool handling requires a conversation in its renderer
        // cache. A raw thread/start alone only creates the app-server record.
        if (typeof manager.resumeConversation === 'function' && !manager.getConversation(threadId)) {
          try { await manager.resumeConversation(threadId); }
          catch (error) { if (!isMissingRolloutError(error)) throw error; }
        }
        const result = await manager.sendRequest('turn/start', params, { priority: 'critical' });
        // An empty thread gains a rollout only after its first turn starts.
        if (typeof manager.resumeConversation === 'function' && !manager.getConversation(threadId)) {
          await manager.resumeConversation(threadId);
        }
        return result;
      },
      async interruptTurn(params) {
        if (!params || typeof params !== 'object') throw new Error('turn/interrupt params are required.');
        const threadId = typeof params.threadId === 'string' ? params.threadId.trim() : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId.trim() : '';
        if (!threadId || !turnId) throw new Error('turn/interrupt requires threadId and turnId.');
        await manager.sendRequest('turn/interrupt', { threadId, turnId }, { priority: 'critical' });
      },
      async rpc(method, params) {
        if (typeof method !== 'string' || !/^[A-Za-z0-9._/-]{1,160}$/.test(method)) {
          throw new Error('Desktop RPC method is invalid.');
        }
        if (method === 'turn/start') return adapter.startTurn(params);
        if (method === 'turn/interrupt') { await adapter.interruptTurn(params); return {}; }
        if (method === 'codex-web/local/history/action') {
          const ids = [], seen = new Set(); let cursor;
          do {
            const page = await manager.sendRequest('thread/turns/list', {threadId:params.threadId,limit:50,itemsView:'notLoaded',sortDirection:'desc',...(cursor ? {cursor} : {})}, {priority:'critical'});
            for (const turn of page.data || []) {
              if (turn.status === 'inProgress') throw new Error('history_changed');
              ids.push(turn.id);
            }
            cursor = page.nextCursor;
            if (ids.length > 100000 || cursor && seen.has(cursor)) throw new Error('invalid_history_cursor');
            if (cursor) seen.add(cursor);
          } while (cursor);
          const index = ids.indexOf(params.turnId);
          if (index < 0 || ids[0] !== params.expectedTailTurnId || new Set(ids).size !== ids.length) throw new Error('history_changed');
          const latest = await manager.sendRequest('thread/turns/list', {threadId:params.threadId,limit:1,itemsView:'notLoaded',sortDirection:'desc'}, {priority:'critical'});
          if (latest.data?.[0]?.id !== ids[0] || latest.data[0].status === 'inProgress') throw new Error('history_changed');
          return params.action === 'fork'
            ? manager.sendRequest('thread/fork', {threadId:params.threadId,lastTurnId:params.turnId,excludeTurns:true}, {priority:'critical'})
            : manager.sendRequest('thread/rollback', {threadId:params.threadId,numTurns:index + 1}, {priority:'critical'});
        }
        if (method === 'codex-web/local/history/page') {
          const page = await manager.sendRequest('thread/turns/list', params, { priority: 'critical' });
          const data = [];
          for (const turn of page.data || []) data.push(await packTurn(params.threadId, turn, params.cursor));
          return { ...page, data };
        }
        if (method === 'codex-web/local/history/item/read') {
          const entry = historyItems.get(params.reference), offset = params.offset;
          if (!entry || entry.threadId !== params.threadId || Date.now() - entry.time > 600000) throw new Error('history_reference_expired');
          entry.time = Date.now();
          const body = entry.body || await rehydrateHistory(entry);
          if (disposed || historyItems.get(params.reference) !== entry) throw new Error('history_reference_expired');
          if (!entry.body) { entry.body = body; historyCharacters += body.length; trimHistoryBodies(params.reference); }
          if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entry.body.length) throw new Error('invalid_history_offset');
          let end = Math.min(entry.body.length, offset + 65536);
          if (end < entry.body.length && /[\uD800-\uDBFF]/.test(entry.body[end - 1])) end--;
          entry.time = Date.now();
          return { data: entry.body.slice(offset, end), offset, nextOffset: end < entry.body.length ? end : null, characters: entry.body.length };
        }
        if (method === 'codex-web/local/server-requests/pending') {
          // Recheck the native cache after backgrounding, suspension, or a desktop response.
          for (const [id, pending] of pendingServerRequests) {
            const conversation = manager.getConversation(pending.conversationId);
            if (conversation && Array.isArray(conversation.requests) && !conversation.requests.some(request => readRequestId(request) === id)) pendingServerRequests.delete(id);
          }
          return Array.from(pendingServerRequests.values());
        }
        if (method === 'codex-web/local/server-requests/respond') {
          const id = readRequestId(params);
          if (id === null) throw new Error('Desktop server request response requires an integer id.');
          await adapter.rpc('codex-web/local/server-requests/pending');
          const pending = pendingServerRequests.get(id);
          if (!pending) throw new Error('No pending Desktop server request found for id ' + String(id) + '.');
          const electronBridge = globalThis.electronBridge;
          if (!electronBridge || typeof electronBridge.sendMessageFromView !== 'function') {
            throw new Error('Codex Desktop response bridge is unavailable.');
          }
          const hasError = Boolean(params && typeof params === 'object' && params.error);
          const result = params && typeof params === 'object' ? params.result : null;
          let responseMessage = null;
          let localReply = null;
          if (pending.method === 'item/commandExecution/requestApproval') {
            const decision = hasError ? 'decline' : (result && typeof result.decision === 'string' ? result.decision : '');
            if (!decision) throw new Error('Command approval response requires a decision.');
            responseMessage = {
              type: 'reply-with-command-execution-approval-decision',
              conversationId: pending.conversationId,
              requestId: id,
              decision
            };
          } else if (pending.method === 'item/fileChange/requestApproval') {
            const decision = hasError ? 'decline' : (result && typeof result.decision === 'string' ? result.decision : '');
            if (!decision) throw new Error('File-change approval response requires a decision.');
            responseMessage = {
              type: 'reply-with-file-change-approval-decision',
              conversationId: pending.conversationId,
              requestId: id,
              decision
            };
          } else if (pending.method === 'item/permissions/requestApproval') {
            const response = hasError ? { permissions: {}, scope: 'turn' } : result;
            if (!response || typeof response !== 'object') {
              throw new Error('Permission approval response is invalid.');
            }
            responseMessage = {
              type: 'reply-with-permissions-request-approval-response',
              conversationId: pending.conversationId,
              requestId: id,
              response
            };
          } else if (pending.method === 'item/tool/requestUserInput' && typeof manager.replyWithUserInputResponse === 'function') {
            if (!result || typeof result.answers !== 'object') throw new Error('User input response is invalid.');
            localReply = () => manager.replyWithUserInputResponse(pending.conversationId, id, result);
          } else if (pending.method === 'mcpServer/elicitation/request' && typeof manager.replyWithMcpServerElicitationResponse === 'function') {
            localReply = () => manager.replyWithMcpServerElicitationResponse(pending.conversationId, id, result);
          } else {
            throw new Error('Desktop server request method is not supported: ' + pending.method + '.');
          }
          // Current desktop builds expose the original app-server reply path.
          // Use it so replies reach the owner even when no native chat view is open.
          if (typeof manager.sendAppServerResponse === 'function') {
            const response = hasError ? { id, error: params.error } : { id, result };
            localReply = () => manager.sendAppServerResponse(pending.method, response);
          }
          pendingServerRequests.delete(id);
          respondingServerRequestIds.add(id);
          let resolvedByDesktop = false;
          try {
            if (localReply) await localReply();
            else await electronBridge.sendMessageFromView(responseMessage);
          } catch (error) {
            resolvedByDesktop = desktopResolvedDuringResponseIds.has(id);
            if (!resolvedByDesktop) {
              let conversation = null;
              try { conversation = manager.getConversation(pending.conversationId); } catch {}
              const requests = conversation && Array.isArray(conversation.requests)
                ? conversation.requests
                : null;
              if (requests === null || requests.some((request) => readRequestId(request) === id)) {
                pendingServerRequests.set(id, pending);
              }
            }
            throw error;
          } finally {
            if (desktopResolvedDuringResponseIds.delete(id)) resolvedByDesktop = true;
            respondingServerRequestIds.delete(id);
          }
          if (!resolvedByDesktop) {
            emit('notification', {
              method: 'server/request/resolved',
              params: {
                id,
                method: pending.method,
                mode: 'web',
                resolvedAtIso: new Date().toISOString()
              }
            });
          }
          return {};
        }
        const result = await manager.sendRequest(method, params ?? null, { priority: 'critical' });
        return result;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const dispose of disposers.splice(0)) {
          try { dispose(); } catch {}
        }
        historyItems.clear(); historyCharacters = 0;
        if (globalThis[globalName] === adapter) delete globalThis[globalName];
      }
    };
    globalThis[globalName] = adapter;
    return {
      protocol,
      hostId: manager.getHostId(),
      capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events', 'server-requests'],
      rendererUrl: globalThis.location && globalThis.location.href
        ? globalThis.location.href
        : 'app://-/index.html'
    };
  })()
