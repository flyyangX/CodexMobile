/**
 * 设备配对门禁：接收终端配对链接或手动输入终端配对码完成 Cookie 登录。
 *
 * Keywords: pairing, device-auth, cookie, terminal-code
 *
 * Exports:
 * - default — `PairingScreen`（未认证时由 `App` 全屏展示）。
 *
 * Inward: `pairing-flow`、`/api/status.pairing`。
 *
 * Outward: `App.jsx` 在 `authenticated === false` 时渲染。
 */

import { Check, Loader2, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  completePairing,
  normalizePairingCode,
  pairingRequestFromSearch,
  startPairingRequest
} from '../pairing-flow.js';
import { unlockPairingPageScroll } from './pairing-scroll-lock.js';

export default function PairingScreen({ pairing: pairingStatus = {}, onPaired }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairingRequest, setPairingRequest] = useState(null);
  const [requestingPair, setRequestingPair] = useState(false);
  const [inputActive, setInputActive] = useState(false);
  const autoPairRef = useRef(pairingRequestFromSearch(globalThis.location?.search || ''));
  const formRef = useRef(null);
  const terminalCommands = Array.isArray(pairingStatus?.commands) && pairingStatus.commands.length
    ? pairingStatus.commands
    : ['cd <CodexMobile 项目目录>', 'npm run pair'];

  function pairingErrorMessage(error) {
    if (error?.status === 410 || /expired/i.test(error?.message || '')) {
      return '这个配对码已过期，请在电脑上重新运行 npm run pair。';
    }
    if (error?.status === 403 || error?.status === 404 || /invalid|not found/i.test(error?.message || '')) {
      return '配对码无效，请检查电脑终端里的 10 位代码，或重新运行 npm run pair。';
    }
    return error?.message || '配对失败，请确认电脑端 CodexMobile 正在运行。';
  }

  function pairingRequestErrorMessage(error) {
    if (error?.status === 429 || error?.retryAfterSeconds) {
      return '配对请求太频繁，请稍后再试。';
    }
    return error?.message || '无法发起配对请求，请确认手机和电脑在同一网络。';
  }

  useEffect(() => {
    return unlockPairingPageScroll();
  }, []);

  useEffect(() => {
    const fromSearch = autoPairRef.current;
    if (!fromSearch) {
      return;
    }
    setCode(fromSearch.code);
    if (typeof globalThis.window?.history?.replaceState === 'function') {
      globalThis.window.history.replaceState(null, '', '/');
    }
  }, []);

  useEffect(() => {
    const fromSearch = autoPairRef.current;
    if (!fromSearch || pairing) {
      return;
    }
    autoPairRef.current = null;
    setPairing(true);
    setError('');
    completePairing({ requestId: fromSearch.requestId, code: fromSearch.code })
      .then(() => onPaired())
      .catch((err) => setError(pairingErrorMessage(err)))
      .finally(() => setPairing(false));
  }, [onPaired, pairing]);

  async function handlePair(event) {
    event.preventDefault();
    if (!code.trim()) {
      setError('请输入配对码');
      return;
    }
    setPairing(true);
    setError('');
    try {
      await completePairing({ requestId: pairingRequest?.requestId, code });
      onPaired();
    } catch (err) {
      setError(pairingErrorMessage(err));
    } finally {
      setPairing(false);
    }
  }

  async function handleStartPairingRequest() {
    setRequestingPair(true);
    setError('');
    try {
      const request = await startPairingRequest();
      setPairingRequest(request);
      setCode('');
      window.setTimeout(scrollFormIntoView, 120);
    } catch (err) {
      setError(pairingRequestErrorMessage(err));
    } finally {
      setRequestingPair(false);
    }
  }

  function scrollFormIntoView() {
    formRef.current?.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }

  function handleCodeFocus() {
    setInputActive(true);
    window.setTimeout(scrollFormIntoView, 120);
    window.setTimeout(scrollFormIntoView, 360);
  }

  return (
    <main className={inputActive ? 'pairing-screen is-input-active' : 'pairing-screen'}>
      <div className="pairing-panel">
        <div className="pairing-brand" aria-label="CodexMobile">
          <img className="pairing-logo" src="/codex-icon-180.png" alt="" aria-hidden="true" />
          <img className="pairing-wordmark" src="/pairing-wordmark.png" alt="" aria-hidden="true" />
        </div>
        <h1>连接你的 Codex</h1>
        <p className="pairing-lead">
          在电脑终端运行 npm run pair，然后输入显示的 10 位配对码。
        </p>
        <div className="pairing-terminal" aria-label="电脑终端命令">
          <div className="pairing-terminal-title">
            <Terminal size={15} />
            <span>电脑终端</span>
          </div>
          {terminalCommands.map((command) => (
            <code key={command}>{command}</code>
          ))}
        </div>
        <div className="pairing-actions">
          <button type="button" className="pairing-secondary-button" onClick={handleStartPairingRequest} disabled={requestingPair || pairing}>
            {requestingPair ? <Loader2 className="spin" size={17} /> : <Terminal size={17} />}
            在手机上发起配对
          </button>
          {pairingRequest?.requestId ? (
            <p className="pairing-request-hint">已在电脑端生成配对码，请查看终端或系统通知后输入。</p>
          ) : null}
        </div>
        <form ref={formRef} className="pairing-form" onSubmit={handlePair}>
          <label htmlFor="pairing-code">配对码</label>
          <div className="pairing-input-row">
            <input
              id="pairing-code"
              inputMode="text"
              placeholder="输入 10 位代码"
              value={code}
              onBlur={() => setInputActive(false)}
              onFocus={handleCodeFocus}
              onChange={(event) => setCode(normalizePairingCode(event.target.value, 10))}
            />
            <button type="submit" disabled={!code.trim() || pairing}>
              {pairing ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
              信任这台设备
            </button>
          </div>
        </form>
        {error ? <div className="pairing-error">{error}</div> : null}
        <p className="pairing-footnote">
          也可以直接打开终端里显示的链接自动配对。配对成功后，这台手机会保存为可信设备。
        </p>
      </div>
    </main>
  );
}
