import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.js';

export interface DropdownOption<T extends string = string> {
  action?: {
    ariaLabel: string;
    className?: string;
    disabled?: boolean;
    label: string;
    onClick: () => Promise<void> | void;
  };
  badge?: string;
  current?: boolean;
  detail?: string;
  group?: string;
  icon?: React.ReactNode;
  label: string;
  title?: string;
  tone?: 'warning';
  value: T;
}

export function DropdownSelect<T extends string>({
  ariaLabel,
  className = '',
  leadingIcon,
  options,
  portal = false,
  title,
  value,
  onChange,
  disabled = false,
}: {
  ariaLabel?: string;
  className?: string;
  leadingIcon?: React.ReactNode;
  options: Array<DropdownOption<T>>;
  portal?: boolean;
  title?: string;
  tone?: 'warning';
  value: T;
  onChange(value: T): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useLayoutEffect(() => {
    if (!open || !portal) {
      setMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const menuHeight = Math.min(320, Math.max(180, window.innerHeight - 220));
      const menuWidth = Math.min(360, Math.max(220, rect.width), window.innerWidth - 16);
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow >= menuHeight + 8 || spaceBelow >= rect.top) {
        setMenuPosition({ left, top: rect.bottom + 6, width: menuWidth });
      } else {
        setMenuPosition({ left, bottom: window.innerHeight - rect.top + 6, width: menuWidth });
      }
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, portal]);

  function selectOption(option: DropdownOption<T>) {
    onChange(option.value);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function close(event: PointerEvent) {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div className={['dropdownSelect', className].filter(Boolean).join(' ')} ref={ref}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={['dropdownButton', selected?.tone ? `tone-${selected.tone}` : ''].filter(Boolean).join(' ')}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        title={title}
        type="button"
      >
        <span className="dropdownSelectedValue">
          {selected?.icon ?? leadingIcon ? <span className="dropdownIcon">{selected?.icon ?? leadingIcon}</span> : null}
          <span>{selected?.label ?? value}</span>
        </span>
        <Icon name="chevronDown" />
      </button>
      {open ? (() => {
        const menu = (
        <div
          className={portal ? ['dropdownMenu dropdownMenuPortal', className].filter(Boolean).join(' ') : 'dropdownMenu'}
          id={id}
          ref={menuRef}
          role="listbox"
          style={portal ? {
            bottom: menuPosition?.bottom ?? 'auto',
            left: menuPosition?.left ?? 0,
            position: 'fixed',
            top: menuPosition?.top ?? 'auto',
            visibility: menuPosition ? 'visible' : 'hidden',
            width: menuPosition?.width ?? 320,
            zIndex: 2200,
          } : undefined}
        >
          {options.map((option, index) => {
            const previous = options[index - 1];
            const showGroup = option.group && option.group !== previous?.group;
            return (
              <React.Fragment key={`${option.group ?? 'group'}-${option.value}`}>
                {showGroup ? <div className="dropdownGroup">{option.group}</div> : null}
                <div className={option.action ? 'dropdownOptionRow' : ''}>
                  <button
                    aria-selected={option.value === value}
                    className={['dropdownOption', option.value === value ? 'active' : '', option.current ? 'current' : '', option.tone ? `tone-${option.tone}` : ''].filter(Boolean).join(' ')}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectOption(option);
                    }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    role="option"
                    title={option.title}
                    type="button"
                  >
                    <span className="dropdownOptionLabel">
                      {option.icon ? <span className="dropdownIcon">{option.icon}</span> : null}
                      <span>{option.label}</span>
                      {option.badge ? <em className="dropdownOptionBadge">{option.badge}</em> : null}
                    </span>
                    {option.detail ? <small>{option.detail}</small> : null}
                  </button>
                  {option.action ? (
                    <button
                      aria-label={option.action.ariaLabel}
                      className={['dropdownOptionAction', option.action.className ?? ''].filter(Boolean).join(' ')}
                      disabled={option.action.disabled}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setOpen(false);
                        void option.action?.onClick();
                      }}
                      type="button"
                    >
                      {option.action.label}
                    </button>
                  ) : null}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        );
        return portal && typeof document !== 'undefined'
          ? createPortal(menu, document.querySelector('.appShell') ?? document.body)
          : menu;
      })() : null}
    </div>
  );
}
