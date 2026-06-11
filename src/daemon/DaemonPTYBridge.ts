import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { OscParser } from '../main/pty/OscParser';
import { AgentDetector } from '../main/pty/AgentDetector';
import { ActivityMonitor } from '../main/pty/ActivityMonitor';
import { parseOsc7Cwd, detectPromptCwd } from '../main/pty/cwdDetect';
import { RingBuffer } from './RingBuffer';
import { PromptEventLog, parseOsc133Payload } from './PromptEventLog';

/**
 * Daemon version of PTYBridge.
 * Replaces BrowserWindow IPC with EventEmitter events.
 *
 * Events:
 *  - 'data'     → Buffer (raw PTY output)
 *  - 'cwd'      → { sessionId: string, cwd: string }
 *  - 'agent'    → { sessionId: string, event: AgentEvent }
 *  - 'critical' → { sessionId: string, event: CriticalEvent }
 *  - 'active'   → { sessionId: string }                — onActive cycle start
 *  - 'idle'     → { sessionId: string }                — onActiveToIdle
 *  - 'exit'     → { sessionId: string, exitCode, signal }
 */
export class DaemonPTYBridge extends EventEmitter {
  private oscParser: OscParser | null = null;
  private agentDetector: AgentDetector | null = null;
  private activityMonitor: ActivityMonitor | null = null;
  private dataDisposable: (() => void) | null = null;
  private exitDisposable: (() => void) | null = null;
  private idleUnsubscribe: (() => void) | null = null;
  private activeUnsubscribe: (() => void) | null = null;
  private agentUnsubscribe: (() => void) | null = null;
  private criticalUnsubscribe: (() => void) | null = null;
  private sessionId: string | null = null;
  /**
   * v2.8.1 hotfix: when true, drop PTY output instead of writing it to
   * the ring buffer. Used by recovery sessions until the renderer has
   * resized the PTY to its actual cols/rows; otherwise output produced
   * at the saved/default geometry interleaves with output the renderer
   * paints at the new geometry.
   *
   * Exit notification is unaffected — `ptyProcess.onExit` fires even
   * while muted so the daemon notices when a recovered shell dies.
   */
  private muted = false;

  /**
   * win32-input-mode (DECSET 9001) state of the foreground app, tracked from
   * the output stream. The renderer reconstructs this flag by replaying the
   * ring buffer on attach, but the `CSI ? 9001 h` that turned it on is
   * evicted once the session outgrows the ring (8 MB default) — reattaching
   * to a long-running codex then silently breaks Ctrl+J / Shift+Enter. The
   * daemon sees every byte, so it is the authority; SessionPipe re-emits the
   * state after each ring replay. RIS (ESC c) resets it like every other
   * mode. Muted chunks ARE scanned: muting drops display bytes the renderer
   * must never paint, but the app still negotiated the mode — the preamble
   * is the only way the renderer can learn about a toggle that was muted.
   */
  private win32InputMode = false;
  /** Tail of the previous chunk so a toggle split across chunks still matches. */
  private win32ModeCarry = '';
  /**
   * RIS, or a private CSI set/reset whose param list may carry 9001 alongside
   * other modes (`ESC [ ? 2004 ; 9001 h`) — the renderer's VT parser accepts
   * the combined form, so a literal-token scan would diverge from it and the
   * replay preamble would then force the renderer WRONG. (C1 CSI 0x9B needs
   * no handling: node-pty decodes the stream as UTF-8, where a raw 0x9B is
   * invalid and becomes U+FFFD on both sides.)
   */
  // eslint-disable-next-line no-control-regex
  private static readonly WIN32_MODE_SCAN = /\x1b(?:c|\[\?([0-9;]*)([hl]))/g;
  /** A carry must be a PREFIX of a potential match — never a completed one. */
  // eslint-disable-next-line no-control-regex
  private static readonly WIN32_MODE_CARRY_PREFIX = /^\x1b(?:\[\??[0-9;]*)?$/;
  /** Longer than any sane DECSET param list; a split beyond this is dropped. */
  private static readonly WIN32_MODE_CARRY_MAX = 64;

  // Prompt-based CWD detection. Parsing is shared with the local PTYBridge via
  // ../main/pty/cwdDetect (parseOsc7Cwd / detectPromptCwd) so both spawn paths
  // stay in lockstep; this only owns the ANSI strip + buffering.
  // eslint-disable-next-line no-control-regex
  private static readonly ANSI_STRIP = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[?]?[0-9;]*[hlm]/g;

  /**
   * Parser-equivalent scan for the win32-input-mode toggles: every private
   * CSI set/reset is parsed and its param list checked for 9001, mirroring
   * xterm's `params.includes(9001)` in the renderer. Tokens are processed in
   * stream order, so the final state is what a real parser would hold. The
   * carry keeps an incomplete trailing sequence (and ONLY an incomplete one —
   * a completed match never re-enters the next scan, so nothing is ever
   * double-counted) up to WIN32_MODE_CARRY_MAX chars.
   */
  private scanWin32InputMode(data: string): void {
    const hay = this.win32ModeCarry + data;
    DaemonPTYBridge.WIN32_MODE_SCAN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DaemonPTYBridge.WIN32_MODE_SCAN.exec(hay)) !== null) {
      if (m[1] === undefined) {
        this.win32InputMode = false; // RIS resets every mode
      } else if (m[1].split(';').includes('9001')) {
        this.win32InputMode = m[2] === 'h';
      }
    }
    const lastEsc = hay.lastIndexOf('\x1b');
    const tail = lastEsc === -1 ? '' : hay.slice(lastEsc);
    this.win32ModeCarry =
      tail.length <= DaemonPTYBridge.WIN32_MODE_CARRY_MAX &&
      DaemonPTYBridge.WIN32_MODE_CARRY_PREFIX.test(tail)
        ? tail
        : '';
  }

  /** Authoritative win32-input-mode state for SessionPipe's replay preamble. */
  getWin32InputMode(): boolean {
    return this.win32InputMode;
  }

  setupDataForwarding(
    ptyProcess: IPty,
    ringBuffer: RingBuffer,
    sessionId: string,
    promptLog?: PromptEventLog,
  ): void {
    const oscParser = new OscParser();
    this.oscParser = oscParser;

    // Fresh PTY → fresh mode state (setupDataForwarding can be re-run on a
    // recovered session; the new shell starts with win32-input-mode off).
    this.win32InputMode = false;
    this.win32ModeCarry = '';

    const agentDetector = new AgentDetector();
    this.agentDetector = agentDetector;

    this.sessionId = sessionId;

    const activityMonitor = new ActivityMonitor();
    this.activityMonitor = activityMonitor;
    activityMonitor.start(sessionId);

    // Activity → idle notification
    this.idleUnsubscribe = activityMonitor.onActiveToIdle((ptyId) => {
      this.emit('idle', { sessionId: ptyId });
    });
    // Activity → active notification (start of a sustained output burst).
    // Also resets AgentDetector emission dedup inside the daemon process so
    // turn N+1's idle prompt fires again even if its text is identical to
    // turn N. The reset MUST happen in-process: AgentDetector instances
    // live in the daemon, so the main-side DaemonNotificationRouter can't
    // reach into them the way local-mode PTYBridge does (Codex P1).
    this.activeUnsubscribe = activityMonitor.onActive((ptyId) => {
      this.agentDetector?.resetEmissionState();
      // gate로 확정된 에이전트 이름을 active 이벤트에 함께 싣는다. main의
      // DaemonNotificationRouter는 daemon AgentDetector에 직접 닿지 못하지만,
      // 같은 daemon 프로세스인 여기서는 getLastAgent()가 닿는다. 이게 있어야
      // idle prompt 패턴이 안 잡히는 에이전트(Claude Code v2.1.x 등)도 running
      // 상태에서 agentName이 채워진다.
      this.emit('active', { sessionId: ptyId, agentName: this.agentDetector?.getLastAgent() ?? undefined });
    });

    // OSC events → cwd (OSC 7) and prompt/command markers (OSC 133)
    oscParser.onOsc((event) => {
      if (event.code === 7) {
        const cwd = parseOsc7Cwd(event.data);
        this.emit('cwd', { sessionId, cwd });
        return;
      }
      if (event.code === 133 && promptLog) {
        const parsed = parseOsc133Payload(event.data, Date.now(), ringBuffer.totalBytesWritten);
        if (parsed) {
          promptLog.append(parsed);
          this.emit('prompt', { sessionId, event: parsed });
        }
      }
    });

    // Agent detection
    this.agentUnsubscribe = agentDetector.onEvent((agentEvent) => {
      this.emit('agent', { sessionId, event: agentEvent });
    });

    // Critical action detection
    this.criticalUnsubscribe = agentDetector.onCritical((criticalEvent) => {
      this.emit('critical', { sessionId, event: criticalEvent });
    });

    // Prompt-based CWD detection state
    let lastDetectedCwd = '';
    let promptBuffer = '';

    // PTY data handler
    const onDataDisposable = ptyProcess.onData((data: string) => {
      // AgentDetector는 순수 텍스트 분석(side effect 없음)이라 muted 구간에서도
      // 돌려야 한다. recovery 세션은 첫 resize 전까지 muted인데, 그 사이에
      // 에이전트 시작 배너("Claude Code vX" 등)가 출력되면 gate 정규식이 영구
      // 미활성화되어 이후 모든 status 감지가 죽는다(daemon mode agent detection
      // 갭). feed만 muted 체크 앞으로 끌어올리고, ring buffer write·emit 등
      // side effect는 여전히 muted로 차단해 geometry mismatch 오염은 막는다.
      try {
        agentDetector.feed(data);
      } catch {
        // detection 실패가 데이터 포워딩을 막아선 안 된다.
      }

      // Mode tracking must see muted chunks too: muting protects the ring /
      // renderer from geometry-mismatched DISPLAY bytes, but a mode the app
      // negotiates during that window (shell profile enabling 9001 before the
      // first resize) is real protocol state — the attach preamble is the
      // only way the renderer ever learns about it. (Codex round-2 #3.)
      this.scanWin32InputMode(data);

      // Muted: drop the chunk before any side effect. Recovery sessions
      // run muted until their first resize so the geometry mismatch
      // window (Bug 2 in v2.8.0) doesn't pollute the ring buffer.
      if (this.muted) return;
      try {
        const buf = Buffer.from(data);
        ringBuffer.write(buf);
        activityMonitor.feed(sessionId, buf.length);
        oscParser.process(data);

        // Prompt-based CWD detection
        promptBuffer += data;
        if (promptBuffer.length > 1024) promptBuffer = promptBuffer.slice(-512);

        const clean = promptBuffer.replace(DaemonPTYBridge.ANSI_STRIP, '');
        const detectedCwd = detectPromptCwd(clean);
        if (detectedCwd !== null) {
          if (detectedCwd !== lastDetectedCwd) {
            lastDetectedCwd = detectedCwd;
            this.emit('cwd', { sessionId, cwd: detectedCwd });
          }
          promptBuffer = '';
        }

        this.emit('data', buf);
      } catch (err) {
        // Still forward raw data even if parsing failed
        this.emit('data', Buffer.from(data));
      }
    });
    this.dataDisposable = () => onDataDisposable.dispose();

    // PTY exit handler. Capture `signal` alongside exitCode: a clean shell
    // exit carries a numeric exitCode and no signal, whereas a terminated
    // process (ConPTY torn down, killed) shows up as a signal or a null
    // exitCode. That distinction is what the silent-death investigation needs
    // to tell "the shell exited on its own" from "something killed it".
    const onExitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
      this.emit('exit', { sessionId, exitCode, signal });
    });
    this.exitDisposable = () => onExitDisposable.dispose();
  }

  /**
   * Mute or unmute PTY output capture. While muted, the data handler
   * drops chunks; ringBuffer pre-fill from saved scrollback (set up by
   * the caller before forwarding starts) is preserved.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * gate로 확정된 에이전트 표시명(없으면 null). daemon 프로세스 안의
   * AgentDetector가 배너를 직접 feed받아 설정하므로, main으로의 1회성
   * session:agent emit 전파(타이밍 race)와 무관하게 권위 있는 값을 준다.
   * renderer의 detection pull이 이 값을 직접 조회한다.
   */
  getLastAgent(): string | null {
    return this.agentDetector?.getLastAgent() ?? null;
  }

  /** Whether the bridge is currently dropping PTY output. */
  get isMuted(): boolean {
    return this.muted;
  }

  cleanup(): void {
    this.dataDisposable?.();
    this.dataDisposable = null;

    this.exitDisposable?.();
    this.exitDisposable = null;

    this.idleUnsubscribe?.();
    this.idleUnsubscribe = null;

    this.activeUnsubscribe?.();
    this.activeUnsubscribe = null;

    // AgentDetector subscriptions: without explicit unsubscribe, recovered
    // sessions or repeated setupDataForwarding calls would accumulate
    // closure-captured callbacks against a stale `agentDetector` reference.
    // (Same leak class as the v2.7.2 PlaywrightEngine CDP session fix.)
    this.agentUnsubscribe?.();
    this.agentUnsubscribe = null;
    this.criticalUnsubscribe?.();
    this.criticalUnsubscribe = null;

    // Stop activity monitor to clear timers and state
    if (this.activityMonitor && this.sessionId) {
      this.activityMonitor.stop(this.sessionId);
    }

    this.oscParser = null;
    this.agentDetector = null;
    this.activityMonitor = null;
    this.sessionId = null;

    this.removeAllListeners();
  }
}
