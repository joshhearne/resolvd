import React, { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import Avatar from '../../components/Avatar';

async function getCroppedBlob(imageSrc, area, outputSize = 256) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = imageSrc;
  });
  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    img,
    area.x, area.y, area.width, area.height,
    0, 0, outputSize, outputSize
  );
  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.92));
}

export default function AccountProfile() {
  const { user, setUser } = useAuth();
  const isLocal = user?.authProvider === 'local';

  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [savingName, setSavingName] = useState(false);

  const [imageSrc, setImageSrc] = useState(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState(null);
  const [uploading, setUploading] = useState(false);

  const onCropComplete = useCallback((_area, areaPx) => setCroppedArea(areaPx), []);

  function onFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be under 5 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => setImageSrc(ev.target.result);
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function applyAvatar() {
    if (!imageSrc || !croppedArea) return;
    setUploading(true);
    try {
      const blob = await getCroppedBlob(imageSrc, croppedArea, 256);
      const fd = new FormData();
      fd.append('avatar', blob, 'avatar.png');
      const res = await fetch('/api/users/me/avatar', {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      // Cache-bust the URL so the new avatar appears instantly.
      const updated = { ...data.user, profilePictureUrl: data.user.profilePictureUrl ? `${data.user.profilePictureUrl}?t=${Date.now()}` : null };
      setUser(updated);
      toast.success('Profile photo updated');
      setImageSrc(null);
      setZoom(1);
      setCrop({ x: 0, y: 0 });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    if (!confirm('Remove your profile photo?')) return;
    try {
      const res = await fetch('/api/users/me/avatar', { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed');
      setUser(data.user);
      toast.success('Profile photo removed');
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function saveDisplayName(e) {
    e.preventDefault();
    if (!displayName.trim()) return;
    setSavingName(true);
    try {
      const res = await fetch('/api/users/me/profile', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: displayName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed');
      setUser(data.user);
      toast.success('Profile updated');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingName(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Avatar block */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Profile photo</h2>
        <div className="flex items-start gap-6">
          <Avatar user={user} size="xl" className="!bg-gray-200 !text-gray-700" />
          <div className="flex-1">
            {isLocal ? (
              <>
                <p className="text-sm text-gray-600 mb-3">
                  Upload a square photo. Recommended: at least 256×256 pixels.
                </p>
                <div className="flex gap-2">
                  <label className="inline-flex items-center px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md cursor-pointer">
                    Choose photo
                    <input type="file" accept="image/*" onChange={onFileSelected} className="hidden" />
                  </label>
                  {user?.profilePictureUrl && (
                    <button onClick={removeAvatar} className="px-3 py-1.5 border border-gray-300 hover:bg-gray-50 text-sm rounded-md">
                      Remove
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-600">
                Your photo is synced from your <strong>{user?.authProvider === 'entra' ? 'Microsoft' : 'Google'}</strong> account on each sign-in.
              </p>
            )}
          </div>
        </div>

        {imageSrc && (
          <div className="mt-6 border border-gray-200 rounded-lg p-4 bg-gray-50">
            <div className="relative w-full h-72 bg-gray-900 rounded-md overflow-hidden">
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            </div>
            <div className="flex items-center gap-3 mt-3">
              <label className="text-xs text-gray-600">Zoom</label>
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={zoom}
                onChange={e => setZoom(Number(e.target.value))}
                className="flex-1"
              />
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setImageSrc(null)} className="px-3 py-1.5 border border-gray-300 hover:bg-gray-50 text-sm rounded-md">
                Cancel
              </button>
              <button
                onClick={applyAvatar}
                disabled={uploading}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm rounded-md"
              >
                {uploading ? 'Saving…' : 'Apply'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Display name */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Display name</h2>
        <form onSubmit={saveDisplayName} className="flex gap-2 max-w-md">
          <input
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            maxLength={120}
            required
          />
          <button
            type="submit"
            disabled={savingName || displayName.trim() === user?.displayName}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm rounded-md"
          >
            {savingName ? 'Saving…' : 'Save'}
          </button>
        </form>
      </section>

      {/* Read-only account info */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Account</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-y-2 gap-x-4 text-sm">
          <dt className="text-gray-500">Email</dt>
          <dd className="sm:col-span-2 text-gray-900">{user?.email || '—'}</dd>
          <dt className="text-gray-500">Sign-in method</dt>
          <dd className="sm:col-span-2 text-gray-900 capitalize">{user?.authProvider}</dd>
          <dt className="text-gray-500">Role</dt>
          <dd className="sm:col-span-2 text-gray-900">{user?.role}</dd>
        </dl>
      </section>
    </div>
  );
}
