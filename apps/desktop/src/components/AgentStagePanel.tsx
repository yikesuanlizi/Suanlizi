// Agent 舞台面板：展示主 Agent 状态卡、子 Agent 网格与运行统计
// Agent stage panel: shows main Agent status card, child agent grid, run stats

import { useCallback, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Locale } from '../config/config.js';
import { formatTimestamp } from '../shared/i18n.js';
import type { AgentStageRow } from '../shared/types.js';

export function AgentStagePanel({
  locale,
  rows,
  selectedThreadId,
  onSelectAgent,
}: {
  locale: Locale;
  rows: AgentStageRow[];
  selectedThreadId?: string | null;
  onSelectAgent?(threadId: string): void;
}) {
  if (rows.length === 0) return null;
  const mainRow = rows.find((row) => row.kind === 'main') ?? rows[0];
  const childRows = rows.filter((row) => row.kind === 'child');
  const statRows = childRows.length > 0 ? childRows : rows;
  const runningCount = statRows.filter((row) => row.tone === 'running').length;
  const doneCount = statRows.filter((row) => row.tone === 'success').length;
  const issueCount = statRows.filter((row) => row.tone === 'warning' || row.tone === 'danger').length;
  const gridRows = childRows;

  const [showNudge, setShowNudge] = useState(() => {
    if (childRows.length > 0) return false;
    try {
      return localStorage.getItem('suanlizi.agentNudgeDismissed') !== '1';
    } catch {
      return true;
    }
  });

  const handleNudgeClick = useCallback(() => {
    setShowNudge(false);
    try {
      localStorage.setItem('suanlizi.agentNudgeDismissed', '1');
    } catch { /* ignore */ }
  }, []);

  return (
    <section className="agentStage" aria-label={locale === 'zh' ? 'Agent 舞台' : 'Agent stage'}>
      <div className="agentStageHeader">
        <div>
          <h2>{locale === 'zh' ? '智能体状态' : 'Agent Status'}</h2>
          <p>{childRows.length > 0
            ? (locale === 'zh' ? '子 Agent 协作状态' : 'Child agent collaboration')
            : (locale === 'zh' ? '当前主 Agent 状态' : 'Current main agent state')}</p>
        </div>
        <span>{childRows.length > 0 ? childRows.length : 1}</span>
      </div>
      <article
        className={['agentStageAvatarCard', mainRow.tone].join(' ')}
        data-selected={selectedThreadId === mainRow.threadId ? 'true' : undefined}
      >
        {/* 机器人本身保留互动（点击换表情/戳一戳），整卡不再跳转详情——
            由 "i" 按钮进入主 Agent 详情；其余区域（含叹号徽标位置）点击均进详情。
            — Chinese: the robot avatar keeps its playful interaction; card body
            clicks (except the avatar) open the main-agent detail via the info button. */}
        {onSelectAgent ? (
          <button
            type="button"
            className="agentStageCardClickLayer"
            onClick={() => onSelectAgent(mainRow.threadId)}
            aria-label={locale === 'zh' ? '查看主 Agent 详情' : 'View main agent details'}
          />
        ) : null}
        {onSelectAgent ? (
          <button
            type="button"
            className="agentStageInfoButton"
            onClick={(event) => { event.stopPropagation(); onSelectAgent(mainRow.threadId); }}
            aria-label={locale === 'zh' ? '查看主 Agent 详情' : 'View main agent details'}
          >
            i
          </button>
        ) : null}
        <div className="agentStageHeroAvatar" aria-hidden="true">
          <RobotMoodIcon variant="main" onInteract={handleNudgeClick} />
          {showNudge && childRows.length === 0 && (
            <button
              type="button"
              className="agentNudgeBubble"
              onClick={handleNudgeClick}
              aria-label={locale === 'zh' ? '戳一戳' : 'Tap me'}
            >
              <span className="nudgeText">{locale === 'zh' ? '戳一戳我' : 'Tap me!'}</span>
              <span className="nudgeArrow" />
            </button>
          )}
        </div>
        <div className="agentStageAvatarInfo">
          <strong>
            {mainAgentTitle(locale)}
            <span className="agentStageVerified" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M9 12.5 11.2 15 16 9.5" /><path d="m12 2 2.2 2.1 3-.4 1.1 2.8 2.7 1.4-.9 2.9.9 2.9-2.7 1.4-1.1 2.8-3-.4L12 22l-2.2-2.1-3 .4-1.1-2.8L3 16.1l.9-2.9L3 10.3l2.7-1.4 1.1-2.8 3 .4L12 2Z" /></svg>
            </span>
          </strong>
          <span className="agentStageStatusLine"><em />{mainAgentStatusText(mainRow, locale)}</span>
          <p>{mainRow.latestAction}</p>
        </div>
      </article>
      {childRows.length > 0 ? (
        <div className="agentStageStats" aria-hidden="true">
          <span>{locale === 'zh' ? '运行' : 'Run'} <strong>{runningCount}</strong></span>
          <span>{locale === 'zh' ? '完成' : 'Done'} <strong>{doneCount}</strong></span>
          <span>{locale === 'zh' ? '注意' : 'Watch'} <strong>{issueCount}</strong></span>
        </div>
      ) : null}
      {gridRows.length > 0 ? (
        <div className="agentStageGrid childAgentTree">
          {gridRows.map((row) => (
          <article
            className={['agentStageCard', row.kind, row.tone, childRows.length === 0 ? 'solo' : ''].join(' ')}
            key={row.threadId}
            style={{ '--agent-depth': row.depth } as CSSProperties}
            data-selected={selectedThreadId === row.threadId ? 'true' : undefined}
          >
            {/* 子 agent 卡整卡点击进详情（含状态徽标），机器人小头像不单独互动。
                — Chinese: the whole child card opens the detail; the small avatar has no separate interaction. */}
            {onSelectAgent ? (
              <button
                type="button"
                className="agentStageCardClickLayer"
                onClick={() => onSelectAgent(row.threadId)}
                aria-label={locale === 'zh' ? `查看 ${row.title} 详情` : `View ${row.title} details`}
              />
            ) : null}
            <div className="agentCardTop">
              <div className="agentAvatar" aria-hidden="true">
                <RobotMoodIcon variant={moodVariantForTone(row.tone)} />
              </div>
              <span className={['agentStageBadge', row.tone].join(' ')}>
                {row.statusLabel}
              </span>
            </div>
            <div className="agentStageMain">
              <div className="agentStageTitleLine">
                <strong>{row.title}</strong>
              </div>
              {row.role && row.role !== row.title ? <span className="agentStageRole">{row.role}</span> : null}
              {row.latestAction ? <p>{row.latestAction}</p> : null}
            </div>
            <time>{formatTimestamp(row.updatedAt, locale)}</time>
          </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export type RobotMoodVariant = 'main' | 'idle' | 'working' | 'thinking' | 'done' | 'sleep';
// 机器人表情变体：主 Agent / 空闲 / 运行 / 思考 / 完成 / 休眠
// Robot mood variants: main / idle / working / thinking / done / sleep

function moodVariantForTone(tone: AgentStageRow['tone']): RobotMoodVariant {
  // 根据行状态（运行/完成/注意/休眠）映射到机器人图标变体
  // Maps the row tone (running / success / warning-or-danger / muted) to a robot icon variant
  if (tone === 'running') return 'working';
  if (tone === 'success') return 'done';
  if (tone === 'warning' || tone === 'danger') return 'thinking';
  if (tone === 'muted') return 'sleep';
  return 'idle';
}

function mainAgentTitle(locale: Locale): string {
  // 主 Agent 标题文本（多语言）
  // Main agent title text (i18n)
  return locale === 'zh' ? 'Suanlizi 主控 Agent' : 'Suanlizi Primary Agent';
}

function mainAgentStatusText(row: AgentStageRow, locale: Locale): string {
  // 主 Agent 副标题：状态 + 最近动作
  // Main agent sub-title: status + latest action
  const status = row.statusLabel || (locale === 'zh' ? '待机中' : 'Standby');
  const action = row.latestAction || (locale === 'zh' ? '等待指令' : 'Awaiting command');
  return `${status} · ${action}`;
}

export function RobotMoodIcon({ variant, onInteract }: { variant: RobotMoodVariant; onInteract?: () => void }) {
  // 输出带动态动画效果（CSS 动画）的机器人 SVG
  // Outputs a robot SVG with animations (CSS-powered)
  if (variant === 'main') {
    return <InteractiveMainRobot onInteract={onInteract} />;
  }

  if (variant === 'working') {
    return (
      <svg className="robotMoodSvg" viewBox="-10 -30 140 160" aria-hidden="true">
        <ellipse cx="60" cy="110" rx="26" ry="5" fill="#cbd5e1"><animate attributeName="rx" values="26; 18; 26" dur="0.6s" repeatCount="indefinite" /></ellipse>
        <g><animateTransform attributeName="transform" type="translate" values="0,-5; 0,-15; 0,-5" dur="0.6s" repeatCount="indefinite" />
          <rect x="25" y="35" width="70" height="60" rx="20" fill="#a7f3d0" stroke="#0f172a" strokeWidth="5" />
          <line x1="60" y1="35" x2="60" y2="20" stroke="#0f172a" strokeWidth="4" strokeLinecap="round" />
          <ellipse cx="60" cy="20" rx="20" ry="5" fill="#34d399" stroke="#0f172a" strokeWidth="3"><animateTransform attributeName="transform" type="rotate" values="0 60 20; 360 60 20" dur="0.2s" repeatCount="indefinite" /></ellipse>
          <rect x="40" y="50" width="40" height="25" rx="8" fill="#0f172a" />
          <g><animateTransform attributeName="transform" type="translate" values="-3,0; 3,0; -3,0" dur="0.8s" repeatCount="indefinite" />
            <circle cx="50" cy="62" r="3" fill="#10b981" /><circle cx="70" cy="62" r="3" fill="#10b981" />
          </g>
        </g>
      </svg>
    );
  }

  if (variant === 'thinking') {
    return (
      <svg className="robotMoodSvg" viewBox="-10 -30 140 160" aria-hidden="true">
        <ellipse cx="60" cy="110" rx="26" ry="5" fill="#cbd5e1"><animate attributeName="rx" values="26; 18; 26" dur="3s" repeatCount="indefinite" /></ellipse>
        <g>
          <animateTransform attributeName="transform" type="translate" values="0,-5; 0,-10; 0,-5" dur="3s" repeatCount="indefinite" />
          <g><animateTransform attributeName="transform" type="rotate" values="-3 60 60; 3 60 60; -3 60 60" dur="4s" repeatCount="indefinite" additive="sum" />
            <rect x="25" y="40" width="70" height="50" rx="18" fill="white" stroke="#0f172a" strokeWidth="5" />
            <path d="M40 90 L30 105" stroke="#0f172a" strokeWidth="5" strokeLinecap="round" />
            <circle cx="25" cy="107" r="8" fill="white" stroke="#0f172a" strokeWidth="4" />
            <circle cx="45" cy="65" r="4" fill="#0f172a"><animate attributeName="cy" values="65; 60; 65" dur="2s" repeatCount="indefinite" /></circle>
            <circle cx="75" cy="65" r="4" fill="#0f172a"><animate attributeName="cy" values="65; 60; 65" dur="2s" repeatCount="indefinite" /></circle>
            <g transform="translate(95, 25)"><circle r="8" fill="#fbbf24" stroke="#0f172a" strokeWidth="3"><animate attributeName="r" values="8; 10; 8" dur="1s" repeatCount="indefinite" /></circle></g>
          </g>
        </g>
      </svg>
    );
  }

  if (variant === 'done') {
    return (
      <svg className="robotMoodSvg" viewBox="-10 -30 140 160" aria-hidden="true">
        <ellipse cx="60" cy="110" rx="26" ry="5" fill="#cbd5e1"><animate attributeName="rx" values="26; 18; 26" dur="1.2s" repeatCount="indefinite" /></ellipse>
        <g>
          <animateTransform attributeName="transform" type="translate" values="0,-5; 0,-13; 0,-7; 0,-13; 0,-5" dur="1.2s" repeatCount="indefinite" additive="sum" />
          <rect x="25" y="35" width="70" height="60" rx="20" fill="#a7f3d0" stroke="#0f172a" strokeWidth="5" />
          <circle cx="45" cy="65" r="4" fill="#f43f5e" opacity="0.4" /><circle cx="75" cy="65" r="4" fill="#f43f5e" opacity="0.4" />
          <path d="M45 70 Q60 85 75 70" stroke="#0f172a" strokeWidth="5" fill="none" strokeLinecap="round" />
          <g transform="translate(100, 20)">
            <path d="M0 -15 L3 -5 L13 -5 L5 2 L8 12 L0 6 L-8 12 L-5 2 L-13 -5 L-3 -5 Z" fill="#fbbf24" stroke="#0f172a" strokeWidth="2">
              <animateTransform attributeName="transform" type="rotate" from="0 0 0" to="360 0 0" dur="2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="1; 0.5; 1" dur="1s" repeatCount="indefinite" />
            </path>
          </g>
        </g>
      </svg>
    );
  }

  if (variant === 'sleep') {
    return (
      <svg className="robotMoodSvg" viewBox="-10 -30 140 160" aria-hidden="true">
        <ellipse cx="60" cy="110" rx="26" ry="5" fill="#e2e8f0"><animate attributeName="rx" values="26; 22; 26" dur="3s" repeatCount="indefinite" /></ellipse>
        <g>
          <animateTransform attributeName="transform" type="translate" values="0,-5; 0,-8; 0,-5" dur="3s" repeatCount="indefinite" />
          <rect x="25" y="45" width="70" height="50" rx="20" fill="#e2e8f0" stroke="#0f172a" strokeWidth="5" />
          <path d="M40 65 L55 65 M75 65 L90 65" stroke="#0f172a" strokeWidth="5" strokeLinecap="round" />
          <path d="M60 45 L60 25" stroke="#0f172a" strokeWidth="5" strokeLinecap="round">
            <animateTransform attributeName="transform" type="rotate" values="0 60 45; 10 60 45; 0 60 45" dur="3s" repeatCount="indefinite" />
          </path>
          <text x="80" y="40" fontSize="20" fontWeight="bold" fill="#64748b">Z<animate attributeName="opacity" values="0; 1; 0" dur="2s" repeatCount="indefinite" /></text>
        </g>
      </svg>
    );
  }

  return (
    <svg className="robotMoodSvg" viewBox="-10 -30 140 160" aria-hidden="true">
      <ellipse cx="60" cy="110" rx="26" ry="5" fill="#cbd5e1"><animate attributeName="rx" values="26; 18; 26" dur="3s" repeatCount="indefinite" /></ellipse>
      <g><animateTransform attributeName="transform" type="translate" values="0,2; 0,-8; 0,2" dur="3s" repeatCount="indefinite" />
        <path d="M60 40 L60 18" stroke="#0f172a" strokeWidth="5" strokeLinecap="round" />
        <circle cx="60" cy="18" r="7" fill="#fbbf24" stroke="#0f172a" strokeWidth="4"><animate attributeName="fill" values="#fbbf24; #fef08a; #fbbf24" dur="1.5s" repeatCount="indefinite" /></circle>
        <rect x="25" y="35" width="70" height="60" rx="24" fill="#ffffff" stroke="#0f172a" strokeWidth="5" />
        <rect x="35" y="50" width="50" height="30" rx="12" fill="#0f172a" />
        <ellipse cx="48" cy="65" rx="5" ry="7" fill="#38bdf8"><animate attributeName="ry" values="7; 1; 7; 7" dur="4s" repeatCount="indefinite" /></ellipse>
        <ellipse cx="72" cy="65" rx="5" ry="7" fill="#38bdf8"><animate attributeName="ry" values="7; 1; 7; 7" dur="4s" repeatCount="indefinite" /></ellipse>
        <circle cx="42" cy="78" r="3" fill="#f43f5e" opacity="0.5" /><circle cx="78" cy="78" r="3" fill="#f43f5e" opacity="0.5" />
      </g>
    </svg>
  );
}

type AgentMood = 'idle' | 'wave' | 'angry' | 'surprised' | 'wink' | 'dizzy';

function InteractiveMainRobot({ onInteract }: { onInteract?: () => void }) {
  const [mood, setMood] = useState<AgentMood>('idle');
  const [clicked, setClicked] = useState(false);
  const [blush, setBlush] = useState(false);
  const isAnimatingRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actions: AgentMood[] = ['wave', 'angry', 'surprised', 'wink', 'dizzy'];

  const handleClick = useCallback(() => {
    if (isAnimatingRef.current) return;
    isAnimatingRef.current = true;

    onInteract?.();

    setClicked(true);
    setTimeout(() => setClicked(false), 400);

    let nextMood: AgentMood = mood;
    while (nextMood === mood) {
      nextMood = actions[Math.floor(Math.random() * actions.length)];
    }
    setMood(nextMood);

    if (nextMood === 'angry') {
      setBlush(true);
    }

    const duration = nextMood === 'wave' ? 1800 : 2000;

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setMood('idle');
      setBlush(false);
      isAnimatingRef.current = false;
    }, duration);
  }, [mood, onInteract]);

  return (
    <svg
      className={`robotMoodSvg mainRobotInteractive ${mood} ${clicked ? 'clicked' : ''} ${blush ? 'blush' : ''}`}
      viewBox="-10 -20 140 140"
      aria-hidden="true"
      onClick={handleClick}
    >
      <ellipse cx="60" cy="110" rx="26" ry="5" fill="#cbd5e1" opacity="0.6">
        <animate attributeName="rx" values="26; 20; 26" dur="3s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.6; 0.3; 0.6" dur="3s" repeatCount="indefinite" />
      </ellipse>

      <g className="robotFloatGroup">
        <animateTransform attributeName="transform" type="translate" values="0,2; 0,-8; 0,2" dur="3s" repeatCount="indefinite" />

        <g fill="none" stroke="#fbbf24" strokeWidth="2" className="antennaRipples">
          <circle cx="60" cy="15" r="7">
            <animate attributeName="r" values="7; 24; 24" keyTimes="0; 0.7; 1" dur="2.4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.8; 0; 0" keyTimes="0; 0.7; 1" dur="2.4s" repeatCount="indefinite" />
          </circle>
          <circle cx="60" cy="15" r="7">
            <animate attributeName="r" values="7; 24; 24" keyTimes="0; 0.7; 1" dur="2.4s" begin="0.8s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.8; 0; 0" keyTimes="0; 0.7; 1" dur="2.4s" begin="0.8s" repeatCount="indefinite" />
          </circle>
          <circle cx="60" cy="15" r="7">
            <animate attributeName="r" values="7; 24; 24" keyTimes="0; 0.7; 1" dur="2.4s" begin="1.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.8; 0; 0" keyTimes="0; 0.7; 1" dur="2.4s" begin="1.6s" repeatCount="indefinite" />
          </circle>
        </g>

        <path d="M60 35 L60 15" stroke="#0f172a" strokeWidth="5" strokeLinecap="round" />
        <circle cx="60" cy="15" r="7" fill="#fbbf24" stroke="#0f172a" strokeWidth="4">
          <animate attributeName="fill" values="#fbbf24; #fef08a; #fbbf24" dur="1.5s" repeatCount="indefinite" />
        </circle>

        <g className="body-group">
          <animateTransform attributeName="transform" type="rotate"
            values="-2 60 65; 2 60 65; -2 60 65" dur="4s" repeatCount="indefinite" />

          <rect x="25" y="35" width="70" height="60" rx="22" fill="#ffffff" stroke="#0f172a" strokeWidth="5" />
          <rect x="35" y="48" width="50" height="32" rx="10" fill="#0f172a" />

          <g className="face-group face-idle">
            <ellipse cx="48" cy="64" rx="5" ry="7" fill="#38bdf8">
              <animate attributeName="ry" values="7; 1; 7; 7" keyTimes="0; 0.05; 0.1; 1" dur="4s" repeatCount="indefinite" />
              <animate attributeName="cx" values="48; 52; 44; 48" keyTimes="0; 0.33; 0.66; 1" dur="5s" repeatCount="indefinite" />
            </ellipse>
            <ellipse cx="72" cy="64" rx="5" ry="7" fill="#38bdf8">
              <animate attributeName="ry" values="7; 1; 7; 7" keyTimes="0; 0.05; 0.1; 1" dur="4s" repeatCount="indefinite" />
              <animate attributeName="cx" values="72; 76; 68; 72" keyTimes="0; 0.33; 0.66; 1" dur="5s" repeatCount="indefinite" />
            </ellipse>
            <path d="M54 74 Q60 74 66 74" stroke="#38bdf8" strokeWidth="2.5" fill="none" strokeLinecap="round">
              <animate attributeName="d"
                values="M54 74 Q60 74 66 74; M54 74 Q60 78 66 74; M54 74 Q60 73 66 74; M54 74 Q60 74 66 74"
                keyTimes="0; 0.33; 0.66; 1" dur="0.6s" repeatCount="indefinite" />
            </path>
          </g>

          <g className="face-group face-wave">
            <path d="M43 64 Q48 58 53 64" stroke="#38bdf8" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <path d="M67 64 Q72 58 77 64" stroke="#38bdf8" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <path d="M52 71 Q60 80 68 71" stroke="#38bdf8" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </g>

          <g className="face-group face-angry">
            <path d="M44 60 L52 68 M52 60 L44 68" stroke="#f43f5e" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M68 60 L76 68 M76 60 L68 68" stroke="#f43f5e" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M42 56 L53 59" stroke="#f43f5e" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M78 56 L67 59" stroke="#f43f5e" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M55 77 Q60 71 65 77" stroke="#f43f5e" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </g>

          <g className="face-group face-surprised">
            <circle cx="48" cy="64" r="4" fill="#38bdf8" />
            <circle cx="72" cy="64" r="4" fill="#38bdf8" />
            <circle cx="60" cy="74" r="3" fill="none" stroke="#38bdf8" strokeWidth="2" />
          </g>

          <g className="face-group face-wink">
            <path d="M43 64 L53 64" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="72" cy="64" r="4" fill="#38bdf8" />
            <path d="M54 74 Q60 78 66 72" stroke="#38bdf8" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </g>

          <g className="face-group face-dizzy">
            <path d="M43 64 Q46 60 49 64 T55 64" stroke="#38bdf8" strokeWidth="2" fill="none" strokeLinecap="round" />
            <path d="M65 64 Q68 60 71 64 T77 64" stroke="#38bdf8" strokeWidth="2" fill="none" strokeLinecap="round" />
            <path d="M53 74 Q56 71 59 74 T65 74" stroke="#38bdf8" strokeWidth="2" fill="none" strokeLinecap="round" />
          </g>

          <circle className="blush-left" cx="42" cy="72" r="3" fill="#f43f5e" opacity="0.6" />
          <circle className="blush-right" cx="78" cy="72" r="3" fill="#f43f5e" opacity="0.6" />
        </g>

        <circle className="hand left-hand" cx="15" cy="65" r="8" fill="#ffffff" stroke="#0f172a" strokeWidth="4" />
        <circle className="hand right-hand" cx="105" cy="65" r="8" fill="#ffffff" stroke="#0f172a" strokeWidth="4" />
      </g>
    </svg>
  );
}
