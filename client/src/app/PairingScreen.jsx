import { Check, Loader2, Monitor } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import {
  PAIRING_REQUEST_COOLDOWN_MS,
  normalizePairingCode,
  pairingRequestCooldownSeconds,
  pairingPromptText,
  pairingRequestDisabled,
  pairingRequestLabel,
  pairingSubmitDisabled
} from '../pairing-flow.js';

export default function PairingScreen({ onPaired, canPair = true }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [requestId, setRequestId] = useState('');
  const [codeLength, setCodeLength] = useState(10);
  const [requesting, setRequesting] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownNow, setCooldownNow] = useState(() => Date.now());
  const cooldownSeconds = pairingRequestCooldownSeconds(cooldownUntil, cooldownNow);

  useEffect(() => {
    if (cooldownSeconds <= 0) {
      return undefined;
    }
    const timer = window.setInterval(() => setCooldownNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  async function requestPairingCode() {
    setRequesting(true);
    setError('');
    try {
      const result = await apiFetch('/api/pair/request', {
        method: 'POST',
        body: {
          deviceName: navigator.platform || 'iPhone'
        }
      });
      setRequestId(result.requestId || '');
      setCodeLength(Number(result.codeLength || 10));
      setCode('');
      const serverCooldownSeconds = Number(result.requestCooldownSeconds);
      const cooldownMs = Number.isFinite(serverCooldownSeconds) && serverCooldownSeconds > 0
        ? serverCooldownSeconds * 1000
        : PAIRING_REQUEST_COOLDOWN_MS;
      const now = Date.now();
      setCooldownNow(now);
      setCooldownUntil(now + cooldownMs);
    } catch (err) {
      const retryAfterSeconds = Number(err.retryAfterSeconds || 0);
      if (retryAfterSeconds > 0) {
        const now = Date.now();
        setCooldownNow(now);
        setCooldownUntil(now + retryAfterSeconds * 1000);
      }
      setError(err.message);
    } finally {
      setRequesting(false);
    }
  }

  async function handlePair(event) {
    event.preventDefault();
    setPairing(true);
    setError('');
    try {
      await apiFetch('/api/pair', {
        method: 'POST',
        body: {
          requestId,
          code,
          deviceName: navigator.platform || 'iPhone'
        }
      });
      onPaired();
    } catch (err) {
      setError(err.message);
    } finally {
      setPairing(false);
    }
  }

  return (
    <main className="pairing-screen">
      <div className="pairing-mark">
        <Monitor size={30} />
      </div>
      <h1>CodexMobile</h1>
      <p className="pairing-lead">
        我的本机 Codex 移动工作台。电脑继续执行，iPhone 随时接管、追问、看过程、处理确认和收完成通知。
      </p>
      <div className="pairing-points" aria-label="CodexMobile 核心能力">
        <span>桌面线程同步</span>
        <span>完整执行过程</span>
        <span>私有网络访问</span>
      </div>
      <p className="pairing-note">
        {pairingPromptText({ requesting, requestId, codeLength, canPair })}
      </p>
      <button
        type="button"
        className="pairing-request-button"
        disabled={pairingRequestDisabled({ requesting, pairing, canPair, cooldownUntil, nowMs: cooldownNow })}
        onClick={requestPairingCode}
      >
        {requesting ? <Loader2 className="spin" size={18} /> : <Monitor size={18} />}
        {pairingRequestLabel({ requesting, requestId, cooldownUntil, nowMs: cooldownNow })}
      </button>
      <form className="pairing-form" onSubmit={handlePair}>
        <input
          inputMode="text"
          autoCapitalize="characters"
          maxLength={codeLength}
          placeholder={`${codeLength} 位配对码`}
          value={code}
          disabled={pairing}
          onChange={(event) => setCode(normalizePairingCode(event.target.value, codeLength))}
        />
        <button type="submit" disabled={pairingSubmitDisabled({ requestId, code, codeLength, pairing, requesting })}>
          {pairing ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
          连接
        </button>
      </form>
      {error ? <div className="pairing-error">{error}</div> : null}
    </main>
  );
}
