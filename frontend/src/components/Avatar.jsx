import React from 'react';

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() || '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const SIZE_CLASS = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-7 h-7 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-20 h-20 text-xl',
  xl: 'w-32 h-32 text-3xl',
};

export default function Avatar({ user, size = 'sm', className = '' }) {
  const url = user?.profilePictureUrl;
  const cls = `${SIZE_CLASS[size] || SIZE_CLASS.sm} rounded-full flex items-center justify-center overflow-hidden bg-white/20 text-white font-semibold flex-shrink-0 ${className}`;

  if (url) {
    return (
      <span className={cls}>
        <img src={url} alt={user?.displayName || ''} className="w-full h-full object-cover" />
      </span>
    );
  }
  return <span className={cls} aria-hidden="true">{initials(user?.displayName)}</span>;
}
