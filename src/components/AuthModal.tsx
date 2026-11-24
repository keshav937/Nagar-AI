import React, { useEffect, useState } from 'react';
import { X, Shield, UserCheck, HeartHandshake, KeyRound, LockKeyhole, Copy, Check } from 'lucide-react';
import type { AuthUser, UserRole } from '../types.ts';
import { apiFetch, setSessionToken } from '../api/client.ts';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticated: (user: AuthUser) => void;
  initialPortal?: 'citizen' | 'caregiver' | 'authority' | 'admin';
}

type PortalTab = 'citizen' | 'caregiver' | 'authority' | 'admin' | 'recover';

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onAuthenticated,
  initialPortal = 'citizen',
}) => {
  const [portal, setPortal] = useState<PortalTab>(initialPortal);
  const [subMode, setSubMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [operatorRole, setOperatorRole] = useState<UserRole>('authority');

  // Admin setup / login
  const [adminStatus, setAdminStatus] = useState<{ envConfigured: boolean; claimed: boolean } | null>(null);
  const [adminPasscode, setAdminPasscode] = useState('');

  // Google OAuth config
  const [googleConfig, setGoogleConfig] = useState<{ configured: boolean; redirectUri?: string } | null>(null);

  // Account recovery
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [recoveryResult, setRecoveryResult] = useState<string | null>(null);

  // Newly issued recovery key (shown once on registration before continuing)
  const [pendingUser, setPendingUser] = useState<{ user: AuthUser; recoveryKey: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPortal(initialPortal);
    setPendingUser(null);
    setRecoveryResult(null);
    setError(null);
    apiFetch<{ envConfigured: boolean; claimed: boolean }>('/api/auth/admin-status')
      .then(setAdminStatus)
      .catch(() => {});
    apiFetch<{ configured: boolean; redirectUri?: string }>('/api/auth/google/config')
      .then(setGoogleConfig)
      .catch(() => {});
  }, [isOpen, initialPortal]);

  // Listen for OAuth callback postMessage
  useEffect(() => {
    if (!isOpen) return;
    const onMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'NAGAR_GOOGLE_AUTH_SUCCESS') {
        const payload = event.data.payload as { token?: string; user?: AuthUser };
        if (payload?.token && payload?.user) {
          setSessionToken(payload.token);
          onAuthenticated(payload.user);
          onClose();
        }
        setLoading(false);
      } else if (event.data.type === 'NAGAR_GOOGLE_AUTH_ERROR') {
        const payload = event.data.payload as { error?: string };
        setError(payload?.error || 'Google Sign-In could not be verified.');
        setLoading(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [isOpen, onAuthenticated, onClose]);

  if (!isOpen) return null;

  const expectedRoleForLogin = (): UserRole => {
    if (portal === 'citizen') return 'citizen';
    if (portal === 'caregiver') return 'caregiver';
    return operatorRole;
  };

  const handleGoogleSignIn = async (targetPortal: 'citizen' | 'caregiver' | 'authority' | 'admin') => {
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ url: string }>(`/api/auth/google/url?portal=${encodeURIComponent(targetPortal)}`);
      const popup = window.open(
        res.url,
        'nagar_google_oauth',
        'width=500,height=640,menubar=no,toolbar=no,location=no,status=no'
      );
      if (!popup) {
        setError('Popup blocked by your browser. Please allow popups for this site to use Google Sign-In.');
        setLoading(false);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Google Sign-In is unavailable. Use email & password or configure GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.'
      );
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          portalRole: expectedRoleForLogin(),
        }),
      });
      setSessionToken(res.token);
      onAuthenticated(res.user);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const regRole: UserRole =
        portal === 'caregiver'
          ? 'caregiver'
          : portal === 'authority' && (operatorRole === 'transit_driver' || operatorRole === 'sanitation_driver')
            ? operatorRole
            : 'citizen';

      const res = await apiFetch<{ token: string; user: AuthUser; recoveryKey?: string }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, phone, password, role: regRole }),
      });
      setSessionToken(res.token);
      if (res.recoveryKey) {
        setPendingUser({ user: res.user, recoveryKey: res.recoveryKey });
      } else {
        onAuthenticated(res.user);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const needsClaim = adminStatus && !adminStatus.envConfigured && !adminStatus.claimed;
      const endpoint = needsClaim ? '/api/auth/claim-admin' : '/api/auth/admin-login';
      const res = await apiFetch<{ token: string; user: AuthUser; recoveryKey?: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          passcode: adminPasscode,
          name: name || 'System Administrator',
          email: email || 'admin@nagar.gov.in',
        }),
      });
      setSessionToken(res.token);
      if (res.recoveryKey) {
        setPendingUser({ user: res.user, recoveryKey: res.recoveryKey });
      } else {
        onAuthenticated(res.user);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Administrator authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setRecoveryResult(null);
    try {
      const res = await apiFetch<{ ok: boolean; newRecoveryKey: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          email,
          recoveryKey: recoveryKeyInput,
          newPassword,
        }),
      });
      setRecoveryResult(
        `Password updated successfully. Your new rotated Recovery Key is ${res.newRecoveryKey}. Save it before signing in.`
      );
      setRecoveryKeyInput('');
      setNewPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password recovery failed.');
    } finally {
      setLoading(false);
    }
  };

  const copyRecoveryKey = async (k: string) => {
    await navigator.clipboard.writeText(k);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const GoogleButton = ({ targetPortal }: { targetPortal: 'citizen' | 'caregiver' | 'authority' | 'admin' }) => (
    <div className="space-y-1.5">
      <button
        type="button"
        disabled={loading}
        onClick={() => handleGoogleSignIn(targetPortal)}
        className="w-full py-2.5 px-3 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-white flex items-center justify-center gap-2 cursor-pointer"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
          />
          <path
            fill="#34A853"
            d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
          />
          <path
            fill="#FBBC05"
            d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
          />
          <path
            fill="#EA4335"
            d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
          />
        </svg>
        Continue with Google ({targetPortal === 'authority' ? 'Authorized Officer' : targetPortal})
      </button>
      {googleConfig && !googleConfig.configured && (
        <p className="text-[11px] text-slate-500 text-center">
          Google OAuth awaits server secrets (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Email login works immediately.
        </p>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Role-Based Portal Authentication"
        className="w-full max-w-lg bg-white dark:bg-[#111916] border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xl max-h-[92vh] overflow-y-auto"
      >
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-base font-display font-bold text-slate-900 dark:text-white">
              NAGAR AI Secure Portal Access
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Select your authorized dashboard portal. Sessions persist securely across reloads.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* One-time Recovery Key display after registration */}
        {pendingUser ? (
          <div className="p-6 space-y-4">
            <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 space-y-2">
              <div className="text-sm font-display font-bold text-emerald-900 dark:text-emerald-200">
                Account Created — Save Your Recovery Key
              </div>
              <p className="text-xs text-emerald-800 dark:text-emerald-300">
                Store this unique recovery key safely. It is required if you ever reset your password.
              </p>
              <div className="flex items-center justify-between gap-2 pt-1">
                <code className="px-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-emerald-300 dark:border-emerald-700 font-mono text-base font-bold tracking-wider">
                  {pendingUser.recoveryKey}
                </code>
                <button
                  type="button"
                  onClick={() => copyRecoveryKey(pendingUser.recoveryKey)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-emerald-600 text-emerald-800 dark:text-emerald-200 cursor-pointer"
                >
                  {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedKey ? 'Copied' : 'Copy Key'}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                onAuthenticated(pendingUser.user);
                onClose();
              }}
              className="w-full py-2.5 text-sm font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
            >
              Continue to {pendingUser.user.role.replace('_', ' ').toUpperCase()} Dashboard
            </button>
          </div>
        ) : (
          <>
            {/* Portal Selector Tabs */}
            <div className="px-6 pt-4">
              <div className="grid grid-cols-5 gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg text-[11px] font-medium">
                {(
                  [
                    ['citizen', 'Citizen', UserCheck],
                    ['caregiver', 'Caregiver', HeartHandshake],
                    ['authority', 'Officer', Shield],
                    ['admin', 'Admin', KeyRound],
                    ['recover', 'Reset', LockKeyhole],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setPortal(id);
                      setError(null);
                      setRecoveryResult(null);
                      if (id === 'authority') setOperatorRole('authority');
                      if (id === 'authority' && subMode === 'register' && operatorRole === 'authority') {
                        setSubMode('login');
                      }
                    }}
                    className={`py-2 px-1 rounded-md flex flex-col items-center gap-1 transition-colors cursor-pointer ${
                      portal === id
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-6">
              {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                  {error}
                </div>
              )}

              {(portal === 'citizen' || portal === 'caregiver' || portal === 'authority') && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2 text-xs">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {portal === 'citizen'
                        ? 'Citizen Portal'
                        : portal === 'caregiver'
                          ? 'Caregiver Access Portal'
                          : 'Authority Officer & Field Operator Portal'}
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setSubMode('login')}
                        className={`px-2.5 py-1 rounded font-medium cursor-pointer ${
                          subMode === 'login'
                            ? 'bg-emerald-700 text-white'
                            : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                        }`}
                      >
                        Sign In
                      </button>
                      {(portal !== 'authority' || operatorRole !== 'authority') && (
                        <button
                          type="button"
                          onClick={() => setSubMode('register')}
                          className={`px-2.5 py-1 rounded font-medium cursor-pointer ${
                            subMode === 'register'
                              ? 'bg-emerald-700 text-white'
                              : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          Register
                        </button>
                      )}
                    </div>
                  </div>

                  {portal === 'authority' && (
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Operational Role
                      </label>
                      <select
                        value={operatorRole}
                        onChange={(e) => {
                          const r = e.target.value as UserRole;
                          setOperatorRole(r);
                          if (r === 'authority') setSubMode('login');
                        }}
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      >
                        <option value="authority">Department Officer (Provisioned by Admin)</option>
                        <option value="transit_driver">Shared Transport Operator</option>
                        <option value="sanitation_driver">Sanitation Field Worker</option>
                      </select>
                    </div>
                  )}

                  {subMode === 'login' ? (
                    <form onSubmit={handleLogin} className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Email
                        </label>
                        <input
                          type="email"
                          required
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Password
                        </label>
                        <input
                          type="password"
                          required
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-2.5 text-sm font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                      >
                        {loading ? 'Signing in...' : `Sign In to ${portal === 'caregiver' ? 'Caregiver Portal' : 'Dashboard'}`}
                      </button>
                    </form>
                  ) : (
                    <form onSubmit={handleRegister} className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Full Name
                        </label>
                        <input
                          type="text"
                          required
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                        />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                            Email
                          </label>
                          <input
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                            Mobile Phone {portal === 'caregiver' ? '(Required)' : ''}
                          </label>
                          <input
                            type="tel"
                            required={portal === 'caregiver'}
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            placeholder="+9198XXXXXXXX"
                            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Password (6+ chars)
                        </label>
                        <input
                          type="password"
                          required
                          minLength={6}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-2.5 text-sm font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                      >
                        {loading ? 'Creating Account...' : `Create ${portal === 'caregiver' ? 'Caregiver' : 'Account'}`}
                      </button>
                    </form>
                  )}

                  <div className="relative py-1">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-slate-200 dark:border-slate-800" />
                    </div>
                    <div className="relative flex justify-center text-[11px] uppercase">
                      <span className="bg-white dark:bg-[#111916] px-2 text-slate-400">Or</span>
                    </div>
                  </div>

                  <GoogleButton targetPortal={portal} />
                </div>
              )}

              {portal === 'admin' && (
                <div className="space-y-4">
                  <form onSubmit={handleAdminSubmit} className="space-y-4">
                    <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 flex items-start gap-2">
                      <KeyRound className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
                      <span>
                        {adminStatus && !adminStatus.envConfigured && !adminStatus.claimed
                          ? 'First-run setup: Claim the System Administrator passcode (min 8 chars) to manage officers and system metrics.'
                          : 'Enter the System Administrator passcode or sign in with an authorized Administrator Google email.'}
                      </span>
                    </div>
                    {adminStatus && !adminStatus.envConfigured && !adminStatus.claimed && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                            Administrator Name
                          </label>
                          <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="System Administrator"
                            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                            Admin Email
                          </label>
                          <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="admin@nagar.gov.in"
                            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Administrator Passcode
                      </label>
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={adminPasscode}
                        onChange={(e) => setAdminPasscode(e.target.value)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full py-2.5 text-sm font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                    >
                      {adminStatus && !adminStatus.envConfigured && !adminStatus.claimed
                        ? 'Claim System Administrator Access'
                        : 'Sign In as Administrator'}
                    </button>
                  </form>

                  <div className="relative py-1">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-slate-200 dark:border-slate-800" />
                    </div>
                    <div className="relative flex justify-center text-[11px] uppercase">
                      <span className="bg-white dark:bg-[#111916] px-2 text-slate-400">Authorized Admin Google</span>
                    </div>
                  </div>

                  <GoogleButton targetPortal="admin" />
                </div>
              )}

              {portal === 'recover' && (
                <form onSubmit={handleResetPassword} className="space-y-3">
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    Reset your password using your registered email and personal Account Recovery Key.
                  </p>
                  {recoveryResult && (
                    <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-300">
                      {recoveryResult}
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-medium mb-1">Registered Email</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Personal Recovery Key</label>
                    <input
                      type="text"
                      required
                      value={recoveryKeyInput}
                      onChange={(e) => setRecoveryKeyInput(e.target.value)}
                      placeholder="12-character hex key"
                      className="w-full px-3 py-2 text-sm font-mono uppercase rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">New Password (6+ chars)</label>
                    <input
                      type="password"
                      required
                      minLength={6}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2.5 text-sm font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                  >
                    {loading ? 'Resetting...' : 'Reset Password'}
                  </button>
                </form>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
