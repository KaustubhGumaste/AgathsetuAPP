import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { VideoView, useVideoPlayer } from 'expo-video';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Image,
  Easing,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  type ScrollViewInstance,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlarmPopup, useCrashAlarm } from './src/alarm';
import {
  Account,
  ApiClient,
  ApiError,
  Role,
  VideoAsset,
  asList,
  asRecord,
  displayDate,
  displayMoney,
  normalizeAccount,
  roleFromAccount,
  textValue,
} from './src/api';
import { requestNotificationPermission, sendLocalNotification } from './src/notify';
import { JUNCTIONS, normalizeStreams, routesFor } from './src/adapters';
import { LiveVideo } from './src/LiveVideo';
import { CrashMonitor, type CrashMonitorStatus, crashMonitorAvailable } from './modules/crash-monitor';
import { type Palette, SettingsProvider, type ThemeMode, colors, pageStatusBarStyle, themedStyles, useSettings } from './src/settings';
import { GoogleSignInCancelled, getGoogleIdToken, googleSignInAvailable, googleSignOut } from './src/google';
import { useCrashLocationShare } from './src/location';
import { IncidentMap, mapIncident, severityLabel } from './src/IncidentMap';

type Tab =
  | 'Dashboard'
  | 'My Vehicles'
  | 'My Violations'
  | 'Pay Fines'
  | 'Payment History'
  | 'Notifications'
  | 'Settings'
  | 'Accident Map'
  | 'Crash Incident Report'
  | 'Overview'
  | 'Live Camera Feeds'
  | 'Junction Overview'
  | 'Routine Violations'
  | 'Fines & Revenue'
  | 'Pending Verification'
  | 'Crash Incident Radar'
  | 'Evidence Records'
  | 'Incident Evidence'
  | 'Junction Evidence'
  | 'Vehicle Registry & Search'
  | 'Vehicle Profile'
  | 'Multi-Junction Tracking'
  | 'Violation Detail'
  | 'Officer Approvals';

type LiveEvent = Record<string, unknown>;
type PaymentMethod = 'upi' | 'card' | 'netbanking';

/** The AGHAT SETHU server. Fixed in the app; EXPO_PUBLIC_API_URL can override it for development. */
const DEFAULT_API_URL = 'https://krishnagumaste.taila639bc.ts.net';
const configuredApiUrl = (process.env.EXPO_PUBLIC_API_URL ?? '').trim() || DEFAULT_API_URL;
const EMERGENCY_NUMBER = '112';

const citizenTabs: Tab[] = [
  'Dashboard',
  'My Vehicles',
  'My Violations',
  'Pay Fines',
  'Payment History',
  'Notifications',
  'Crash Incident Report',
  'Settings',
];

const authorityTabs: Tab[] = [
  'Overview',
  'Accident Map',
  'Live Camera Feeds',
  'Junction Overview',
  'Routine Violations',
  'Fines & Revenue',
  'Pending Verification',
  'Crash Incident Radar',
  'Evidence Records',
  'Incident Evidence',
  'Junction Evidence',
  'Vehicle Registry & Search',
  'Vehicle Profile',
  'Multi-Junction Tracking',
  'Violation Detail',
  'Settings',
];

/**
 * Sections whose endpoint is optional: a server that answers 404 for the probe path does not offer
 * the section, so it is hidden instead of showing an error.
 */
const optionalTabProbes: Partial<Record<Tab, string>> = {
  'Junction Overview': '/api/authority/junctions',
  'Pending Verification': '/api/authority/pending-verifications',
  'Vehicle Registry & Search': '/api/authority/vehicles',
  'Vehicle Profile': '/api/authority/vehicles',
  'Multi-Junction Tracking': '/api/authority/vehicles',
  'Officer Approvals': '/api/admin/authority-accounts',
  'Routine Violations': '/api/routine-violations/detect',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const VERDICT_LABELS: Record<string, string> = {
  VISION_CONFIRMED: 'Camera confirmed the plate',
  PROBABLE_MATCH: 'Probable match (unconfirmed)',
  NOT_CONFIRMED: 'Camera read a different plate',
  NO_PLATE_VISIBLE: 'No plate visible',
  PLATE_TOO_SMALL: 'Plate too small to read',
};

function field(record: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return undefined;
}

/** The array stored under exactly `key` (no fallbacks), or an empty list. */
function listField(value: unknown, key: string): unknown[] {
  const item = asRecord(value)[key];
  return Array.isArray(item) ? item : [];
}

function recordId(record: Record<string, unknown>) {
  return textValue(field(record, 'id', 'fine_id', 'incident_id', 'job_id', 'reference'));
}

function labelForRole(role: Role) {
  if (role === 'citizen') return 'Citizen';
  if (role === 'admin') return 'Administrator';
  if (role === 'super_admin') return 'Super Administrator';
  return 'Authority';
}

function routeForTab(
  tab: Tab,
  selectedId?: string,
  selectedVehicle?: string,
  searchText = '',
  fineFilter: 'All' | 'Paid' | 'Unpaid' = 'All',
  year = String(new Date().getFullYear()),
  junction = '',
) {
  const id = encodeURIComponent(selectedId ?? '');
  const plate = encodeURIComponent(selectedVehicle ?? '');
  switch (tab) {
    case 'Dashboard':
      return '/api/citizen/fines';
    case 'Settings':
      return '/api/auth/me';
    case 'Accident Map':
      return '/api/incidents/board';
    case 'My Vehicles':
      return '/api/citizen/vehicles';
    case 'My Violations':
    case 'Pay Fines':
      return '/api/citizen/fines';
    case 'Payment History':
      return '/api/citizen/payments';
    case 'Notifications':
      return '/api/citizen/notifications';
    case 'Crash Incident Report':
      return selectedId ? `/api/citizen/incidents/${id}` : '';
    case 'Overview':
      return '/api/authority/summary';
    case 'Live Camera Feeds':
      return '/api/cameras/status';
    case 'Junction Overview':
      return '/api/authority/junctions';
    case 'Fines & Revenue': {
      const validYear = /^\d{4}$/.test(year) && Number(year) >= 2000 && Number(year) <= 2100
        ? year
        : String(new Date().getFullYear());
      return `/api/authority/fines?status=${encodeURIComponent(fineFilter === 'All' ? 'all' : fineFilter)}&year=${encodeURIComponent(validYear)}`;
    }
    case 'Pending Verification':
      return '/api/authority/pending-verifications';
    case 'Crash Incident Radar':
      return '/api/incidents/board';
    case 'Evidence Records':
      return '/api/incidents';
    case 'Incident Evidence':
      return selectedId
        ? `/api/incidents/${id}`
        : '/api/incidents';
    case 'Junction Evidence':
      return selectedId && junction ? `/api/incidents/${id}/junctions/${encodeURIComponent(junction)}` : '';
    case 'Vehicle Registry & Search':
      return `/api/authority/vehicles?q=${encodeURIComponent(searchText)}`;
    case 'Vehicle Profile':
      return selectedVehicle ? `/api/authority/vehicles/${plate}` : '';
    case 'Multi-Junction Tracking':
      return selectedVehicle ? `/api/authority/vehicles/${plate}/tracks` : '';
    case 'Violation Detail':
      return selectedId ? `/api/authority/fines/${id}` : '';
    case 'Officer Approvals':
      return '/api/admin/authority-accounts';
    default:
      return '';
  }
}

function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function Button({
  title,
  onPress,
  secondary = false,
  disabled = false,
  danger = false,
  compact = false,
  inverted = false,
  style,
}: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  danger?: boolean;
  compact?: boolean;
  inverted?: boolean;
  style?: object;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      android_ripple={{ color: secondary || inverted ? colors.ripple : 'rgba(255,255,255,0.25)' }}
      disabled={disabled}
      hitSlop={compact ? 6 : 0}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        secondary && styles.buttonSecondary,
        danger && styles.buttonDanger,
        inverted && styles.buttonInverted,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
        style,
      ]}
    >
      <Text
        numberOfLines={2}
        style={[styles.buttonText, secondary && styles.buttonTextSecondary, inverted && styles.buttonTextInverted]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

/**
 * Safety-critical action that must be deliberate: it fires only after the button is held for
 * HOLD_MS. A tap (or an accidental touch) just shows how to confirm.
 */
const HOLD_MS = 900;

function HoldButton({
  title,
  onConfirm,
  disabled = false,
  inverted = false,
  style,
}: {
  title: string;
  onConfirm: () => void;
  disabled?: boolean;
  inverted?: boolean;
  style?: object;
}) {
  const [progress] = useState(() => new Animated.Value(0));
  const [hint, setHint] = useState(false);
  const animation = useRef<Animated.CompositeAnimation | null>(null);

  const start = () => {
    setHint(false);
    animation.current?.stop();
    progress.setValue(0);
    animation.current = Animated.timing(progress, { toValue: 1, duration: HOLD_MS, easing: Easing.linear, useNativeDriver: false });
    animation.current.start();
  };
  const cancel = () => {
    animation.current?.stop();
    Animated.timing(progress, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  };

  return (
    <View>
      <Pressable
        accessibilityHint="Press and hold to confirm"
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        delayLongPress={HOLD_MS}
        disabled={disabled}
        onLongPress={() => {
          cancel();
          onConfirm();
        }}
        onPress={() => setHint(true)}
        onPressIn={start}
        onPressOut={cancel}
        style={[styles.button, inverted && styles.buttonInverted, disabled && styles.buttonDisabled, styles.holdButton, style]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.holdFill,
            { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
          ]}
        />
        <Text numberOfLines={2} style={[styles.buttonText, inverted ? styles.buttonTextInverted : styles.buttonTextSecondary]}>{title}</Text>
      </Pressable>
      <Text style={[styles.holdHint, inverted && styles.holdHintInverted]}>
        {hint ? 'Keep holding the button for a second to confirm.' : 'Press and hold to confirm.'}
      </Text>
    </View>
  );
}

function Input({
  label,
  value,
  onChangeText,
  secureTextEntry = false,
  placeholder,
  keyboardType,
  autoCapitalize = 'sentences',
  autoComplete,
  returnKeyType,
  onSubmitEditing,
  maxLength,
  hint,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'number-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoComplete?: 'email' | 'username' | 'password' | 'new-password' | 'name' | 'tel' | 'off';
  returnKeyType?: 'done' | 'next' | 'search' | 'go';
  onSubmitEditing?: () => void;
  maxLength?: number;
  hint?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel={label}
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete}
          autoCorrect={false}
          keyboardType={keyboardType}
          maxLength={maxLength}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmitEditing}
          placeholder={placeholder}
          placeholderTextColor={colors.placeholder}
          returnKeyType={returnKeyType}
          secureTextEntry={secureTextEntry && !revealed}
          style={[styles.input, styles.inputFlex]}
          value={value}
        />
        {secureTextEntry ? (
          <Pressable
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setRevealed((current) => !current)}
            style={styles.revealButton}
          >
            <Text style={styles.revealText}>{revealed ? 'Hide' : 'Show'}</Text>
          </Pressable>
        ) : null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label?: (value: T) => string;
}) {
  return (
    <View style={styles.methodRow}>
      {options.map((option) => (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: value === option }}
          key={option}
          onPress={() => onChange(option)}
          style={[styles.methodButton, value === option && styles.methodButtonActive]}
        >
          <Text style={[styles.methodText, value === option && styles.methodTextActive]}>{label ? label(option) : option}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Tag({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'good' | 'warning' | 'bad' }) {
  return (
    <View style={[styles.tag, tone === 'good' && styles.tagGood, tone === 'warning' && styles.tagWarning, tone === 'bad' && styles.tagBad]}>
      <Text style={[styles.tagText, tone === 'good' && styles.tagTextGood, tone === 'warning' && styles.tagTextWarning, tone === 'bad' && styles.tagTextBad]}>
        {children}
      </Text>
    </View>
  );
}

function ScreenTitle({ title, caption }: { title: string; caption?: string }) {
  return (
    <View style={styles.screenTitle}>
      <Text accessibilityRole="header" style={styles.screenTitleText}>{title}</Text>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function mediaSource(api: ApiClient, path: string) {
  try {
    const base = new URL(api.getBaseUrl());
    const target = new URL(/^https?:\/\//i.test(path) ? path : api.url(path));
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    return { uri: target.toString(), sameOrigin: target.origin === base.origin };
  } catch {
    return null;
  }
}

function AuthScreen({
  api,
  onLogin,
  notice,
}: {
  api: ApiClient;
  onLogin: (account: Account) => void;
  notice?: string;
}) {
  const [portal, setPortal] = useState<'citizen' | 'authority' | 'admin'>('citizen');
  const [mode, setMode] = useState<'home' | 'login' | 'register'>('home');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [infoPage, setInfoPage] = useState<keyof typeof publicInfoPages | null>(null);
  // Signup email verification: the code step, the address it was sent to, and the resend countdown.
  const [otpStep, setOtpStep] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpEmail, setOtpEmail] = useState('');
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

  const resetOtp = () => {
    setOtpStep(false);
    setOtpCode('');
    setOtpEmail('');
    setResendIn(0);
  };

  const enterPortal = (value: 'citizen' | 'authority' | 'admin') => {
    // Never carry typed credentials from one portal into another.
    setValues({});
    setPortal(value);
    setMode('login');
    setError('');
    setMessage('');
    resetOtp();
  };

  const sendCode = async (email: string) => {
    const result = await api.requestEmailOtp(email);
    setOtpEmail(email);
    setOtpCode('');
    setOtpStep(true);
    setResendIn(60);
    setMessage(typeof result.message === 'string' ? result.message : `A 6-digit code was sent to ${email}.`);
  };

  /** Creates the account; `verificationToken` proves the email when the server requires it. */
  const registerAccount = async (verificationToken?: string) => {
    const token: Record<string, string> = verificationToken ? { email_verification_token: verificationToken } : {};
    // Field names must match backend/schemas.py (CitizenRegistration / AuthorityRegistration).
    if (portal === 'citizen') {
      await api.registerCitizen({
        name: (values.name ?? '').trim(),
        email: (values.email ?? '').trim(),
        mobile: (values.mobile ?? '').trim(),
        password: values.password ?? '',
        vehicle_registration_number: (values.vehicle_registration_number ?? '').replace(/\s/g, '').toUpperCase(),
        ...token,
      });
      setMessage(`${verificationToken ? 'Email verified. ' : ''}Citizen account registered. Sign in to continue.`);
    } else if (portal === 'authority') {
      await api.registerAuthority({
        name: (values.name ?? '').trim(),
        email: (values.email ?? '').trim(),
        badge_number: (values.badge_number ?? '').trim(),
        jurisdiction: (values.jurisdiction ?? '').trim(),
        password: values.password ?? '',
        ...token,
      });
      setMessage(`${verificationToken ? 'Email verified. ' : ''}Officer account submitted. It is awaiting approval.`);
    } else {
      throw new ApiError('Admin accounts are created by the backend administrator.');
    }
    resetOtp();
    setValues((current) => ({ email: current.email ?? '' }));
    setMode('login');
  };

  const verifyCode = async () => {
    if (!/^\d{6}$/.test(otpCode)) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const verificationToken = await api.verifyEmailOtp(otpEmail, otpCode);
      await registerAccount(verificationToken);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The code could not be verified.');
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    setBusy(true);
    setError('');
    try {
      await sendCode(otpEmail);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send a new code.');
    } finally {
      setBusy(false);
    }
  };

  const validate = () => {
    const email = (values.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
    if (!values.password) return 'Enter your password.';
    if (mode !== 'register') return '';
    if ((values.name ?? '').trim().length < 2) return 'Enter your full name.';
    if (values.password.length < 8) return 'Password must be at least 8 characters.';
    if (values.password !== values.confirmPassword) return 'Password and confirmation do not match.';
    if (portal === 'citizen') {
      if ((values.mobile ?? '').replace(/\D/g, '').length < 7) return 'Enter a valid mobile number.';
      if ((values.vehicle_registration_number ?? '').replace(/\s/g, '').length < 4) {
        return 'Enter your vehicle registration number (for example KA01AB1234).';
      }
    } else {
      if ((values.badge_number ?? '').trim().length < 2) return 'Enter your badge or service number.';
      if ((values.jurisdiction ?? '').trim().length < 2) return 'Enter your jurisdiction or unit.';
    }
    return '';
  };

  const submit = async () => {
    const invalid = validate();
    setMessage('');
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (mode === 'register') {
        if (portal === 'admin') throw new ApiError('Admin accounts are created by the backend administrator.');
        // Servers that verify email first send a code; the account is created after it is confirmed.
        if (await api.emailOtpRequired()) {
          await sendCode((values.email ?? '').trim().toLowerCase());
          return;
        }
        await registerAccount();
        return;
      }
      const account = await api.login((values.email ?? '').trim(), values.password ?? '');
      const actualRole = roleFromAccount(account);
      const roleMatchesPortal = portal === 'citizen'
        ? actualRole === 'citizen'
        : portal === 'authority'
          ? actualRole === 'authority'
          : actualRole === 'admin' || actualRole === 'super_admin';
      if (!roleMatchesPortal) {
        await api.logout();
        throw new ApiError('This account belongs to a different portal. Choose the correct sign-in.');
      }
      if (actualRole !== 'citizen' && String(account.status ?? '').toLowerCase().includes('pending')) {
        await api.logout();
        throw new ApiError('Your officer account is awaiting approval.');
      }
      onLogin(account);
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : 'The request failed.';
      setError(text);
    } finally {
      setBusy(false);
    }
  };

  const googleReady = googleSignInAvailable();

  /**
   * Google sign-in. From the portal chooser (`anyRole`) the account opens its own portal; from a
   * portal form it must belong to that portal, like password sign-in.
   */
  const googleSignIn = async (target: 'citizen' | 'authority' | 'admin', anyRole = false) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const idToken = await getGoogleIdToken();
      const { account } = await api.loginWithGoogle(idToken, target);
      const actualRole = roleFromAccount(account);
      const roleMatchesPortal = target === 'citizen'
        ? actualRole === 'citizen'
        : target === 'authority'
          ? actualRole === 'authority'
          : actualRole === 'admin' || actualRole === 'super_admin';
      if (!anyRole && !roleMatchesPortal) {
        await api.logout();
        throw new ApiError('This Google account belongs to a different portal. Choose the correct sign-in.');
      }
      onLogin(account);
    } catch (reason) {
      if (reason instanceof GoogleSignInCancelled) return;
      setError(reason instanceof Error ? reason.message : 'Google sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const renderGoogle = (target: 'citizen' | 'authority' | 'admin', anyRole = false) => (googleReady ? (
    <>
      <Button disabled={busy} onPress={() => void googleSignIn(target, anyRole)} secondary title="G   Continue with Google" />
      <Text style={styles.orDivider}>or use your email</Text>
    </>
  ) : null);

  const renderFields = () => {
    if (mode === 'home') return null;
    if (mode === 'register' && otpStep) {
      return (
        <Card style={styles.authCard}>
          <Text style={styles.cardTitle}>Verify your email</Text>
          <Text style={styles.caption}>Enter the 6-digit code sent to {otpEmail}. It expires in 10 minutes. Check the spam folder if it does not arrive.</Text>
          <Input
            autoComplete="off"
            keyboardType="number-pad"
            label="Verification code"
            maxLength={6}
            onChangeText={(value) => setOtpCode(value.replace(/\D/g, ''))}
            onSubmitEditing={() => void verifyCode()}
            placeholder="123456"
            returnKeyType="go"
            value={otpCode}
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {message && !error ? <Text style={styles.successText}>{message}</Text> : null}
          <Button disabled={busy || otpCode.length !== 6} onPress={() => void verifyCode()} title={busy ? 'Checking…' : 'Verify and create account'} />
          <Button
            disabled={busy || resendIn > 0}
            onPress={() => void resendCode()}
            secondary
            title={resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
          />
          <Button onPress={() => { resetOtp(); setError(''); setMessage(''); }} secondary title="Change email or details" />
        </Card>
      );
    }
    const common = (
      <>
        <Input
          autoCapitalize="none"
          autoComplete={mode === 'login' ? 'username' : 'email'}
          keyboardType="email-address"
          label={portal === 'citizen' ? 'Email' : 'Official email'}
          onChangeText={(value) => set('email', value)}
          placeholder="name@example.com"
          returnKeyType="next"
          value={values.email ?? ''}
        />
        {mode === 'register' && (
          <>
            <Input autoCapitalize="words" autoComplete="name" label="Full name" maxLength={120} onChangeText={(value) => set('name', value)} value={values.name ?? ''} />
            {portal === 'citizen' ? (
              <>
                <Input autoComplete="tel" keyboardType="phone-pad" label="Mobile" maxLength={30} onChangeText={(value) => set('mobile', value)} placeholder="+91 98765 43210" value={values.mobile ?? ''} />
                <Input
                  autoCapitalize="characters"
                  hint="Required. Crash alerts are sent for vehicles registered to your account."
                  label="Vehicle registration number"
                  maxLength={20}
                  onChangeText={(value) => set('vehicle_registration_number', value.toUpperCase())}
                  placeholder="KA01AB1234"
                  value={values.vehicle_registration_number ?? ''}
                />
              </>
            ) : (
              <>
                <Input label="Badge / service number" maxLength={80} onChangeText={(value) => set('badge_number', value)} value={values.badge_number ?? ''} />
                <Input autoCapitalize="words" label="Jurisdiction / unit" maxLength={120} onChangeText={(value) => set('jurisdiction', value)} value={values.jurisdiction ?? ''} />
              </>
            )}
          </>
        )}
        <Input
          autoCapitalize="none"
          autoComplete={mode === 'register' ? 'new-password' : 'password'}
          hint={mode === 'register' ? 'At least 8 characters.' : undefined}
          label="Password"
          maxLength={128}
          onChangeText={(value) => set('password', value)}
          onSubmitEditing={mode === 'login' ? () => void submit() : undefined}
          returnKeyType={mode === 'login' ? 'go' : 'next'}
          secureTextEntry
          value={values.password ?? ''}
        />
        {mode === 'register' && (
          <Input
            autoCapitalize="none"
            autoComplete="new-password"
            label="Confirm password"
            maxLength={128}
            onChangeText={(value) => set('confirmPassword', value)}
            onSubmitEditing={() => void submit()}
            returnKeyType="go"
            secureTextEntry
            value={values.confirmPassword ?? ''}
          />
        )}
      </>
    );

    return (
      <Card style={styles.authCard}>
        <Text style={styles.cardTitle}>{mode === 'login'
        ? `${portal === 'citizen' ? 'Citizen' : portal === 'authority' ? 'Authority' : 'Admin / Super Admin'} sign in`
        : `${portal === 'citizen' ? 'Citizen' : 'Authority'} registration`}</Text>
        {mode === 'login' && portal === 'authority' && (
        <Text style={styles.noticeText}>For authorised traffic police and control-room officers only. Access is logged.</Text>
        )}
        {mode === 'login' && portal === 'admin' && (
        <Text style={styles.noticeText}>Admin accounts are provisioned by the backend operator. Admin access is limited to accident locations and officer approvals; Super Admin has full operations access.</Text>
        )}
        {mode === 'login' || portal === 'citizen' ? renderGoogle(portal) : null}
        {common}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {message ? <Text style={styles.successText}>{message}</Text> : null}
        <Button disabled={busy} onPress={submit} title={busy ? 'Connecting…' : mode === 'login' ? 'Sign in' : 'Continue'} />
        {mode === 'register' ? <Text style={styles.caption}>We may email you a 6-digit code to confirm this address.</Text> : null}
        {portal !== 'admin' ? (
          <Button onPress={() => { resetOtp(); setError(''); setMode(mode === 'login' ? 'register' : 'login'); }} secondary title={mode === 'login' ? 'Create an account' : 'Back to sign in'} />
        ) : null}
        <Button onPress={() => { setMode('home'); setValues({}); setError(''); setMessage(''); resetOtp(); }} secondary title="Back to portal selection" />
      </Card>
    );
  };

  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.safeArea}>
      {/* Light page background: dark status-bar icons (light-content made them invisible). */}
      <StatusBar style={pageStatusBarStyle()} />
      <ScrollView
        contentContainerStyle={[
          styles.authPage,
          { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 32, paddingLeft: insets.left + 20, paddingRight: insets.right + 20 },
        ]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        style={styles.flex}
      >
        {notice ? <Card style={styles.authCard}><Text style={styles.noticeTextPlain}>{notice}</Text></Card> : null}
        <View style={styles.brandBlock}>
          <Text style={styles.brandMark}>AGHAT SETHU</Text>
          <Text style={styles.heroTitle}>Safer roads through connected evidence.</Text>
          <Text style={styles.heroBody}>Accident detection, vehicle identification and multi-junction investigation.</Text>
        </View>
        {mode === 'home' ? (
          <Card style={styles.authCard}>
            <Text style={styles.cardTitle}>Choose your portal</Text>
            <Text style={styles.caption}>Your signed-in account is routed to its own role-protected portal.</Text>
            {googleReady ? (
              <>
                <Button disabled={busy} onPress={() => void googleSignIn('citizen', true)} title="G   Continue with Google" />
                <Text style={styles.caption}>Fastest for citizens: no password or form. Officers and admins with a matching email are signed in to their own portal.</Text>
                {error ? <Text style={styles.errorText}>{error}</Text> : null}
                <Text style={styles.orDivider}>or choose a portal</Text>
              </>
            ) : null}
            <Button onPress={() => enterPortal('citizen')} secondary={googleReady} title="Citizen Login" />
            <Button onPress={() => enterPortal('authority')} secondary title="Authority Login" />
            <Button onPress={() => enterPortal('admin')} secondary title="Admin / Super Admin Login" />
            <Text style={styles.caption}>Authority accounts require approval. Admin and Super Admin accounts are created securely on the backend, not in the app.</Text>
          </Card>
        ) : renderFields()}
        <View style={styles.infoLinks}>
          {(Object.keys(publicInfoPages) as Array<keyof typeof publicInfoPages>).map((key) => (
            <Pressable accessibilityRole="button" key={key} onPress={() => setInfoPage(key)}>
              <Text style={styles.infoLink}>{publicInfoPages[key].title}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      {/* Edge-to-edge: keep scrolled content from showing through the status bar. */}
      <View pointerEvents="none" style={[styles.statusBarScrim, { height: insets.top }]} />
      <Modal
        animationType="fade"
        navigationBarTranslucent
        onRequestClose={() => setInfoPage(null)}
        statusBarTranslucent
        transparent
        visible={infoPage !== null}
      >
        <Pressable accessibilityLabel="Close" onPress={() => setInfoPage(null)} style={styles.modalShade}>
          <Pressable onPress={() => undefined} style={[styles.card, styles.infoCard]}>
            <ScrollView bounces={false} style={styles.modalScroll}>
              <Text style={styles.cardTitle}>{infoPage ? publicInfoPages[infoPage].title : ''}</Text>
              <Text style={styles.bodyText}>{infoPage ? publicInfoPages[infoPage].content : ''}</Text>
            </ScrollView>
            <Button onPress={() => setInfoPage(null)} secondary title="Close" />
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const publicInfoPages = {
  privacy: {
    title: 'Privacy Policy',
    content: 'Account and incident information is retrieved from the configured AGHAT SETHU server. Evidence is available only through authenticated endpoints. The app stores native sign-in tokens in secure device storage; browser sign-in tokens are kept in memory and are cleared on page reload. Consult your service operator for the deployment-specific retention policy.',
  },
  terms: {
    title: 'Terms of Use',
    content: 'Use this application only with an authorized service account. Payment actions in this project use a simulated gateway and do not transfer money. Crash alerts and incident records are informational and do not replace contacting emergency services.',
  },
  accessibility: {
    title: 'Accessibility',
    content: 'Interactive controls expose button roles and visible labels. If you encounter an accessibility barrier, contact the administrator responsible for your AGHAT SETHU deployment.',
  },
  help: {
    title: 'Help & Contact',
    content: 'For sign-in, account approval, or service availability issues, contact the administrator responsible for your deployment. This build does not provide a public support email address or emergency hotline.',
  },
} as const;

function ProtectedImage({ api, path }: { api: ApiClient; path: string }) {
  const [failed, setFailed] = useState(false);
  const media = mediaSource(api, path);
  if (failed || !media) {
    return (
      <View style={styles.mediaMissing}>
        <Text style={styles.mediaMissingText}>No evidence image is available for this record.</Text>
      </View>
    );
  }
  return (
    <Image
      accessibilityLabel="Evidence image"
      onError={() => setFailed(true)}
      resizeMode="contain"
      source={{
        uri: media.uri,
        headers: media.sameOrigin && api.currentToken ? { Authorization: `Bearer ${api.currentToken}` } : undefined,
      }}
      style={styles.evidenceImage}
    />
  );
}

/** Probes the clip with a 1-byte range request first, so no empty player is shown when there is no clip. */
function ProtectedVideo({ api, path }: { api: ApiClient; path: string }) {
  const media = mediaSource(api, path);
  const [state, setState] = useState<'checking' | 'available' | 'missing'>('checking');
  useEffect(() => {
    if (!media) return undefined;
    let active = true;
    const headers: Record<string, string> = { Range: 'bytes=0-0' };
    if (media.sameOrigin && api.currentToken) headers.Authorization = `Bearer ${api.currentToken}`;
    fetch(media.uri, { headers })
      .then((response) => { if (active) setState(response.ok ? 'available' : 'missing'); })
      .catch(() => { if (active) setState('missing'); });
    return () => { active = false; };
  }, [api, media?.uri, media?.sameOrigin]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!media || state === 'missing') {
    return (
      <View style={styles.mediaMissing}>
        <Text style={styles.mediaMissingText}>No video clip is available for this record.</Text>
      </View>
    );
  }
  if (state === 'checking') return <ActivityIndicator color={colors.primary} style={styles.inlineSpinner} />;
  return <ProtectedVideoPlayer api={api} media={media} />;
}

function ProtectedVideoPlayer({ api, media }: { api: ApiClient; media: { uri: string; sameOrigin: boolean } }) {
  const source = useMemo(() => ({
    uri: media.uri,
    headers: media.sameOrigin && api.currentToken ? { Authorization: `Bearer ${api.currentToken}` } : undefined,
  }), [api, media.sameOrigin, media.uri]);
  const player = useVideoPlayer(source);
  return <VideoView contentFit="contain" nativeControls player={player} style={styles.video} />;
}

function DataCard({
  value,
  api,
  onSelect,
  children,
}: {
  value: unknown;
  api: ApiClient;
  onSelect?: () => void;
  children?: React.ReactNode;
}) {
  if (value === null || typeof value !== 'object') {
    return (
      <Card>
        <Text selectable style={styles.cardTitle}>{textValue(value)}</Text>
        {children}
      </Card>
    );
  }
  const record = asRecord(value);
  const rawTitle = textValue(field(record, 'title', 'plate_number', 'plate', 'challan_number', 'receipt_number', 'reference', 'name', 'kind', 'id', 'incident_id', 'vehicle_registration_number', 'junction_id', 'month') ?? 'Record');
  // Notification kinds such as `crash_involvement` read as "Crash involvement".
  const titleText = 'kind' in record && rawTitle === textValue(record.kind)
    ? rawTitle.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
    : rawTitle;
  const entries = Object.entries(record).filter(([key, item]) => (
    !/base64|raw_frame/i.test(key)
    && !HIDDEN_CARD_KEYS.has(key)
    && item !== null && item !== undefined && item !== ''
    // Skip values already shown as the card title, and duplicate timestamps.
    && !(typeof item !== 'object' && (String(item) === titleText || String(item) === rawTitle) && key !== 'status')
    && !(key === 'created_at' && 'issued_at' in record)
    && !(key === 'time' && 'occurred_at' in record)
    && !(key === 'vehicle_registration_number' && 'plate_number' in record)
  ));
  // Only real media links count as images (not e.g. `last_frame_at` timestamps).
  const images = entries.filter(([key, item]) => /image|snapshot|evidence|photo|frame/i.test(key) && typeof item === 'string' && /^(\/|https?:\/\/)/i.test(item));
  const status = String(field(record, 'status', 'payment_status', 'plate_status') ?? '');
  const statusLower = status.toLowerCase();
  const statusTone = statusLower === 'paid' || statusLower === 'confirmed' || statusLower === 'resolved'
    ? 'good'
    : statusLower === 'unpaid' || statusLower === 'unresolved' || statusLower === 'failed'
      ? 'bad'
      : statusLower === 'pending' || statusLower === 'low_confidence'
        ? 'warning'
        : 'neutral';
  return (
    <Pressable
      accessibilityHint={onSelect ? 'Opens details' : undefined}
      accessibilityRole={onSelect ? 'button' : undefined}
      disabled={!onSelect}
      onPress={onSelect}
      style={({ pressed }) => (pressed && onSelect ? styles.pressedCard : undefined)}
    >
      <Card>
        <View style={styles.cardHeading}>
          <Text numberOfLines={2} style={[styles.cardTitle, styles.shrink]}>{titleText}</Text>
          {status ? <Tag tone={statusTone}>{status}</Tag> : null}
        </View>
        {entries.slice(0, 14).map(([key, item]) => {
          if (images.some(([imageKey]) => imageKey === key)) return null;
          const money = /amount|revenue|total_unpaid|pending$|collected/i.test(key) && typeof item !== 'object';
          const date = /time|date|created|_at$|timestamp|detected/i.test(key) && typeof item === 'string';
          return (
            <View key={key} style={styles.dataLine}>
              <Text style={styles.dataLabel}>{key.replaceAll('_', ' ')}</Text>
              <Text selectable style={styles.dataValue}>
                {money ? displayMoney(item) : date ? displayDate(item) : formatCell(item)}
              </Text>
            </View>
          );
        })}
        {images.slice(0, 2).map(([key, path]) => (
          <View key={key}>
            <Text style={styles.caption}>{key.replaceAll('_', ' ')}</Text>
            <ProtectedImage api={api} path={String(path)} />
          </View>
        ))}
        {children}
      </Card>
    </Pressable>
  );
}

/** Internal identifiers that mean nothing to the reader; they are still used for navigation. */
const HIDDEN_CARD_KEYS = new Set(['id', 'fine_id', 'vehicle_id', 'user_id', 'run_id', 'event_id', 'cached']);

/** Readable text for nested values instead of raw JSON. */
function formatCell(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map(formatCell).join(', ') : '—';
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = Object.entries(record)
      .filter(([key, item]) => (
        item !== null && item !== undefined && item !== ''
        && !HIDDEN_CARD_KEYS.has(key)
        && !(key === 'vehicle_registration_number' && 'plate_number' in record)
      ))
      .map(([key, item]) => `${key.replaceAll('_', ' ')}: ${formatCell(item)}`);
    return parts.length ? parts.join(' · ') : '—';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return textValue(value);
}

function EvidenceItem({ api, value }: { api: ApiClient; value: unknown }) {
  const record = asRecord(value);
  const url = field(record, 'url');
  return (
    <DataCard api={api} value={value}>
      {typeof url === 'string' ? <ProtectedImage api={api} path={url} /> : null}
    </DataCard>
  );
}

function VideoJob({
  api,
  job,
}: {
  api: ApiClient;
  job: Record<string, unknown> | null;
}) {
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState('');
  const id = job && field(job, 'job_id', 'id');

  useEffect(() => {
    setResult(null);
    setError('');
    if (typeof id !== 'string' && typeof id !== 'number') return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await api.get<Record<string, unknown>>(
          `/api/routine-violations/jobs/${encodeURIComponent(String(id))}`,
        );
        if (cancelled) return;
        setResult(response);
        const status = String(field(response, 'status') ?? '').toLowerCase();
        if (status === 'queued' || status === 'processing') timer = setTimeout(poll, 3000);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not retrieve job status.');
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, id]);

  if (!job) return null;
  return (
    <Card>
      <Text style={styles.cardTitle}>Video analysis job</Text>
      <Text style={styles.bodyText}>Job ID: {textValue(id)}</Text>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {result ? <DataCard api={api} value={result} /> : <ActivityIndicator color={colors.primary} />}
    </Card>
  );
}

function PaymentFineCard({
  api,
  fine,
  onPayment,
}: {
  api: ApiClient;
  fine: unknown;
  onPayment: (fineId: string, method: PaymentMethod) => Promise<void>;
}) {
  const [method, setMethod] = useState<PaymentMethod>('upi');
  const [evidenceVisible, setEvidenceVisible] = useState(false);
  const record = asRecord(fine);
  const id = recordId(record);
  const paid = String(field(record, 'status', 'payment_status') ?? '').toLowerCase() === 'paid';
  return (
    <DataCard api={api} value={fine}>
      {!paid && (
        <>
          <Text style={styles.caption}>Payment method (simulated gateway)</Text>
          <Chips
            label={(option) => ({ upi: 'UPI', card: 'Card', netbanking: 'Net banking' })[option]}
            onChange={setMethod}
            options={['upi', 'card', 'netbanking'] as const}
            value={method}
          />
        </>
      )}
      <View style={styles.inlineButtons}>
        <Button compact onPress={() => setEvidenceVisible((current) => !current)} secondary title={evidenceVisible ? 'Hide evidence' : 'View evidence'} />
        {!paid && (
          <Button compact onPress={() => void onPayment(id, method)} title={`Pay ${displayMoney(field(record, 'amount', 'fine_amount'))}`} />
        )}
      </View>
      {evidenceVisible && (
        <View style={styles.mediaBlock}>
          <ProtectedImage api={api} path={`/api/citizen/fines/${encodeURIComponent(id)}/snapshot`} />
          <ProtectedVideo api={api} path={`/api/citizen/fines/${encodeURIComponent(id)}/clip`} />
        </View>
      )}
    </DataCard>
  );
}

function Portal({
  account,
  api,
  onLogout,
  banner,
}: {
  account: Account;
  api: ApiClient;
  onLogout: () => Promise<void>;
  banner?: string;
}) {
  const role = roleFromAccount(account);
  const isCitizen = role === 'citizen';
  const portalServer = api.currentDialect === 'portal';
  const allTabs: Tab[] = isCitizen
    ? citizenTabs
    : role === 'admin'
      ? ['Accident Map', 'Junction Overview', 'Crash Incident Radar', 'Incident Evidence', 'Officer Approvals', 'Settings']
      : role === 'super_admin'
        ? [...authorityTabs.filter((item) => item !== 'Settings'), 'Officer Approvals', 'Settings']
        : authorityTabs;
  // Optional sections are probed once; until then they are hidden so nothing flashes an error.
  const [probed, setProbed] = useState(false);
  const tabs = useMemo(() => {
    const visible = allTabs.filter((item) => {
      const probe = optionalTabProbes[item];
      return !probe || (probed && !api.isMissing(probe));
    });
    return visible.length ? visible : ['Crash Incident Radar' as Tab];
  }, [allTabs.join('|'), probed, api]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let active = true;
    const paths = [...new Set(allTabs.map((item) => optionalTabProbes[item]).filter((item): item is string => !!item))];
    void api.probe(paths).finally(() => { if (active) setProbed(true); });
    return () => { active = false; };
  }, [api, role]); // eslint-disable-line react-hooks/exhaustive-deps
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>(tabs[0]);
  const [selectedJunction, setSelectedJunction] = useState('');
  const [selectedFine, setSelectedFine] = useState<unknown>(null);
  const [resolveNote, setResolveNote] = useState('');
  const [streams, setStreams] = useState<ReturnType<typeof normalizeStreams> | null>(null);
  const [videoStatus, setVideoStatus] = useState<Record<string, string>>({});
  const crashNotificationIds = useRef(new Map<string, string>());
  const [menuOpen, setMenuOpen] = useState(false);
  const [data, setData] = useState<unknown>(null);
  const [loadedTab, setLoadedTab] = useState<Tab | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [globalError, setGlobalError] = useState('');
  const [paymentMessage, setPaymentMessage] = useState('');
  const [profileMessage, setProfileMessage] = useState('');
  const [profileName, setProfileName] = useState(account.name ?? '');
  const [savedName, setSavedName] = useState(account.name ?? '');
  const [profileMobile, setProfileMobile] = useState(account.mobile ?? '');
  const [selectedId, setSelectedId] = useState('');
  const [selectedVehicle, setSelectedVehicle] = useState('');
  const [vehicleSearchDraft, setVehicleSearchDraft] = useState('');
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [resolvePassword, setResolvePassword] = useState('');
  const [resolveMessage, setResolveMessage] = useState('');
  const [job, setJob] = useState<Record<string, unknown> | null>(null);
  const [liveEvent, setLiveEvent] = useState<LiveEvent | null>(null);
  const [liveError, setLiveError] = useState('Connecting to the live camera stream…');
  const [frameData, setFrameData] = useState<Record<string, string>>({});
  const [livePlateEvents, setLivePlateEvents] = useState<unknown[]>([]);
  const lastFrameUpdate = useRef(0);
  const [tracksData, setTracksData] = useState<unknown>(null);
  const [rfidHealth, setRfidHealth] = useState<unknown>(null);
  // Authority crash alerts waiting to be acknowledged (newest first).
  const [authorityAlerts, setAuthorityAlerts] = useState<LiveEvent[]>([]);
  // Citizen crash alarm
  const [alarmPending, setAlarmPending] = useState(false);
  const [alarmMuted, setAlarmMuted] = useState(false);
  const [confirmationIncidentId, setConfirmationIncidentId] = useState('');
  const [confirmationIncident, setConfirmationIncident] = useState<Record<string, unknown> | null>(null);
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const [notificationFilter, setNotificationFilter] = useState<'All' | 'Unread' | 'E-challan' | 'Crash'>('All');
  const [fineFilter, setFineFilter] = useState<'All' | 'Paid' | 'Unpaid'>('All');
  const [finesYearDraft, setFinesYearDraft] = useState(String(new Date().getFullYear()));
  const [finesYear, setFinesYear] = useState(String(new Date().getFullYear()));
  const settings = useSettings();
  const [vehicleCount, setVehicleCount] = useState(() => (Array.isArray(account.vehicles) ? account.vehicles.length : -1));
  const [newPlate, setNewPlate] = useState('');
  const [vehicleMessage, setVehicleMessage] = useState('');
  // Citizen: the crash whose responders receive this phone's live location, and until when (after
  // "Yes, I need help" sharing continues for an hour or until the incident is resolved).
  const [sharingIncidentId, setSharingIncidentId] = useState('');
  const [shareUntil, setShareUntil] = useState<number | null>(null);
  const locationShare = useCrashLocationShare(api, sharingIncidentId, isCitizen && !portalServer && settings.shareLocation);
  // Authority: the crash selected on the accident map.
  const [mapIncidentId, setMapIncidentId] = useState('');
  const seenNotificationIds = useRef(new Set<string>());
  const notificationsInitialized = useRef(false);
  const answeredIncidents = useRef(new Set<string>());
  const scrollRef = useRef<ScrollViewInstance>(null);
  const tabScrollRef = useRef<ScrollViewInstance>(null);
  const tabPositions = useRef<Partial<Record<Tab, number>>>({});
  const requestSeq = useRef(0);

  const alarmActive = (isCitizen && alarmPending) || (!isCitizen && authorityAlerts.length > 0);
  const activeAuthorityAlert = authorityAlerts[0];
  useCrashAlarm({
    active: alarmActive,
    soundMuted: alarmMuted,
    title: isCitizen ? 'Possible crash involving your vehicle' : `Crash detected · ${textValue(field(asRecord(activeAuthorityAlert), 'junction_id', 'junction'))}`,
    body: isCitizen
      ? 'Open AGHAT SETHU and tell us whether you are safe.'
      : 'Open AGHAT SETHU to acknowledge and review the incident.',
    data: { incidentId: isCitizen ? confirmationIncidentId : textValue(field(asRecord(activeAuthorityAlert), 'incident_id', 'id')) },
  });

  /**
   * Loads the active section. `silent` refreshes (polling) keep the current content on screen and
   * never show the loading spinner or clear it on a transient error.
   */
  const refresh = useCallback(async (
    { target = tab, id = selectedId, silent = false }: { target?: Tab; id?: string; silent?: boolean } = {},
  ) => {
    const seq = ++requestSeq.current;
    if (target === 'Violation Detail' && portalServer) {
      // The portal backend has no per-fine endpoint; the record from the fines list is complete.
      setData(selectedFine);
      setLoadedTab(target);
      setError('');
      return;
    }
    const path = routeForTab(target, id, selectedVehicle, vehicleSearch, fineFilter, finesYear, selectedJunction);
    if (!path) {
      setData(null);
      setLoadedTab(target);
      setError('');
      return;
    }
    if (!silent) {
      setBusy(true);
      setError('');
    }
    try {
      const next = await api.get<unknown>(path);
      if (seq !== requestSeq.current) return; // a newer request (e.g. another tab) superseded this one
      setData(next);
      setLoadedTab(target);
      if (silent) setError('');
    } catch (reason) {
      if (seq !== requestSeq.current) return;
      if (!silent) {
        setError(reason instanceof Error ? reason.message : 'Could not load this section.');
        setData(null);
        setLoadedTab(target);
      }
    } finally {
      if (seq === requestSeq.current) setBusy(false);
    }
  }, [api, fineFilter, finesYear, portalServer, selectedFine, selectedId, selectedJunction, selectedVehicle, tab, vehicleSearch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh({ silent: false });
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  // Ask for notification permission once after sign-in, so alarms can reach the lock screen.
  useEffect(() => {
    void requestNotificationPermission().catch(() => undefined);
  }, []);

  // Installed Android app: keep watching for crashes after the app is closed. Citizens watch their
  // own notifications (the server has matched the crashed plate to its owner); authorities watch
  // the incident board.
  useEffect(() => {
    if (!crashMonitorAvailable || !api.currentToken || !api.getBaseUrl()) return;
    const path = isCitizen
      ? '/api/citizen/notifications'
      : api.currentDialect === 'portal' ? '/api/incidents/board?view=radar' : '/api/incidents/board';
    CrashMonitor.start(api.getBaseUrl(), api.currentToken, isCitizen ? 'citizen' : 'authority', path, 5000);
  }, [api, isCitizen]);

  // While the in-app alarm is showing it may cover the lock screen, and it replaces the background
  // monitor's siren so only one plays.
  // Cancel on both edges: when the in-app alarm opens, and when it is answered or dismissed (the
  // background monitor may have posted its own alarm a few seconds after the in-app one opened).
  useEffect(() => {
    CrashMonitor.setShowOverLockScreen(alarmActive);
    CrashMonitor.cancelAlarm();
  }, [alarmActive]);

  // Authorities: opening the app from a background crash alarm silences it; the radar shows the crash.
  useEffect(() => {
    if (isCitizen) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') CrashMonitor.cancelAlarm();
    });
    return () => subscription.remove();
  }, [isCitizen]);

  // Authority live socket: camera frames go straight to the frame hub (no React state per frame);
  // crash alerts raise the alarm until acknowledged.
  useEffect(() => {
    if (isCitizen || !api.currentToken || !api.getBaseUrl()) return undefined;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    let connect: () => Promise<void>;
    const scheduleReconnect = (delay = Math.min(1000 * 2 ** retry, 15000)) => {
      if (cancelled) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      retry = Math.min(retry + 1, 4);
      reconnectTimer = setTimeout(() => void connect(), delay);
    };
    connect = async () => {
      if (cancelled || (socket && socket.readyState <= 1)) return;
      try {
        const connection = await api.authenticatedSocket('/ws/live-cameras');
        if (cancelled) {
          connection.close();
          return;
        }
        socket = connection;
        connection.onopen = () => {
          retry = 0;
          setLiveError('');
        };
        connection.onmessage = (message) => {
          if (typeof message.data !== 'string') return;
          try {
            const event = asRecord(JSON.parse(message.data));
            setLiveError('');
            const eventName = String(field(event, 'type', 'event', 'kind') ?? '');
            const junction = String(field(event, 'junction_id', 'junction', 'camera_id') ?? 'unknown');
            const frame = field(event, 'image', 'image_base64', 'jpeg_base64', 'frame_base64', 'jpeg');
            if (eventName === 'vehicle_boxes' || eventName === 'plate_detection' || eventName === 'live_plate_detection') {
              const detections = asList(event, ['detections', 'vehicles', 'boxes']);
              const results = detections.length > 0
                ? detections
                : field(event, 'plate', 'plate_number', 'text') !== undefined
                  ? [event]
                  : [];
              if (results.length > 0) setLivePlateEvents((current) => [...current, ...results].slice(-12));
            }
            if (typeof frame === 'string' && Date.now() - lastFrameUpdate.current >= 250) {
              lastFrameUpdate.current = Date.now();
              const imageUri = /^data:image\//i.test(frame) ? frame : `data:image/jpeg;base64,${frame}`;
              setFrameData((current) => ({ ...current, [junction]: imageUri }));
            }
            if (eventName !== 'camera_frame' && eventName !== 'vehicle_boxes') setLiveEvent(event);
            if (eventName === 'crash_alert') {
              setAuthorityAlerts((current) => {
                const incidentId = textValue(field(event, 'incident_id', 'id'));
                if (current.some((item) => textValue(field(item, 'incident_id', 'id')) === incidentId)) return current;
                return [event, ...current].slice(0, 20);
              });
              setAlarmMuted(false);
            }
          } catch {
            setLiveError('The camera sender sent an unreadable event.');
          }
        };
        connection.onerror = () => setLiveError('Live connection interrupted; reconnecting…');
        connection.onclose = (event) => {
          if (socket === connection) socket = null;
          if (cancelled) return;
          if (event.code === 1008) {
            setLiveError(event.reason || 'The live feed rejected this session. Sign in again.');
            return;
          }
          setLiveError(`Live connection closed (${event.code}); reconnecting…`);
          scheduleReconnect();
        };
      } catch (reason) {
        if (cancelled) return;
        setLiveError(reason instanceof Error ? `${reason.message} Reconnecting…` : 'Could not connect to live cameras; reconnecting…');
        scheduleReconnect();
      }
    };
    void connect();
    // Android drops sockets of backgrounded apps: reconnect at once when the app comes back.
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !socket) {
        retry = 0;
        scheduleReconnect(0);
      }
    });
    return () => {
      cancelled = true;
      appState.remove();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [api, isCitizen]);

  const raiseCitizenAlarm = useCallback((incidentId: string, incident?: Record<string, unknown>) => {
    if (!incidentId || incidentId === '—' || answeredIncidents.current.has(incidentId)) return;
    setSharingIncidentId(incidentId);
    setShareUntil(null);
    setConfirmationIncidentId(incidentId);
    setConfirmationIncident(incident ?? null);
    setConfirmationMessage('');
    setAlarmMuted(false);
    setAlarmPending(true);
    if (!incident) {
      void api.get<unknown>(`/api/citizen/incidents/${encodeURIComponent(incidentId)}`)
        .then((detail) => setConfirmationIncident(asRecord(detail)))
        .catch(() => undefined);
    }
  }, [api]);

  // Citizen: instant alerts over the WebSocket, with polling as a fallback. The web-portal backend
  // has no citizen alert socket; there the notification poll below raises the alarm.
  useEffect(() => {
    if (!isCitizen || portalServer || !api.currentToken || !api.getBaseUrl()) return undefined;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    const connect = async () => {
      if (cancelled || (socket && socket.readyState <= 1)) return;
      try {
        const connection = await api.authenticatedSocket('/ws/citizen/alerts');
        if (cancelled) {
          connection.close();
          return;
        }
        socket = connection;
        connection.onopen = () => { retry = 0; };
        connection.onmessage = (message) => {
          if (typeof message.data !== 'string') return;
          try {
            const event = asRecord(JSON.parse(message.data));
            if (String(field(event, 'type') ?? '') === 'crash_involvement') {
              const incidentId = textValue(field(event, 'incident_id'));
              const notification = asRecord(field(event, 'notification'));
              const notificationId = recordId(notification);
              if (notificationId !== '—') seenNotificationIds.current.add(notificationId);
              raiseCitizenAlarm(incidentId, asRecord(field(event, 'incident')));
            }
          } catch {
            // ignore malformed message
          }
        };
        connection.onclose = (event) => {
          if (socket === connection) socket = null;
          if (cancelled || event.code === 1008) return;
          reconnectTimer = setTimeout(() => void connect(), Math.min(1000 * 2 ** retry++, 30000));
        };
      } catch {
        if (cancelled) return;
        reconnectTimer = setTimeout(() => void connect(), Math.min(1000 * 2 ** retry++, 30000));
      }
    };
    void connect();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !socket) {
        retry = 0;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        void connect();
      }
    });
    return () => {
      cancelled = true;
      appState.remove();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [api, isCitizen, portalServer, raiseCitizenAlarm]);

  useEffect(() => {
    if (!isCitizen || !api.currentToken || !api.getBaseUrl()) return undefined;
    let active = true;
    const checkNotifications = async () => {
      try {
        const response = await api.get<unknown>('/api/citizen/notifications');
        if (!active) return;
        const unansweredOnStart: string[] = [];
        for (const item of asList(response, ['notifications'])) {
          const record = asRecord(item);
          const id = recordId(record);
          if (id === '—') continue;
          const kind = String(field(record, 'kind', 'type') ?? 'Account update');
          const incidentId = textValue(field(record, 'incident_id'));
          const isCrash = kind.toLowerCase().includes('crash') && incidentId !== '—';
          if (isCrash) crashNotificationIds.current.set(incidentId, id);
          if (!notificationsInitialized.current) {
            // Crash alerts that arrived while the app was closed must still raise the alarm.
            if (isCrash && !field(record, 'read_at')) unansweredOnStart.push(incidentId);
          } else if (!seenNotificationIds.current.has(id)) {
            if (isCrash) raiseCitizenAlarm(incidentId);
            else {
              void sendLocalNotification(
                kind.replaceAll('_', ' '),
                String(field(record, 'message', 'title') ?? 'A new account notification is available.'),
              ).catch(() => undefined);
            }
          }
          seenNotificationIds.current.add(id);
        }
        if (!notificationsInitialized.current) {
          notificationsInitialized.current = true;
          for (const incidentId of unansweredOnStart) {
            try {
              const incident = asRecord(await api.get<unknown>(`/api/citizen/incidents/${encodeURIComponent(incidentId)}`));
              if (!active) return;
              if (!field(incident, 'response') && String(field(incident, 'status') ?? '') !== 'resolved') {
                raiseCitizenAlarm(incidentId, incident);
                break;
              }
            } catch {
              // incident no longer visible to this citizen
            }
          }
        }
        setGlobalError('');
      } catch (reason) {
        if (active) setGlobalError(reason instanceof Error ? reason.message : 'Could not refresh notifications.');
      }
    };
    void checkNotifications();
    // Without a push socket (web-portal backend) poll faster so the alarm still starts within seconds.
    const timer = setInterval(() => void checkNotifications(), portalServer ? 5000 : 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, isCitizen, portalServer, raiseCitizenAlarm]);

  // Authority live video: WHEP streams when the server publishes them; JPEG frames otherwise.
  useEffect(() => {
    if (isCitizen) return undefined;
    let active = true;
    void api.get<unknown>('/api/streams')
      .then((response) => { if (active) setStreams(normalizeStreams(response)); })
      .catch(() => { if (active) setStreams(null); });
    return () => { active = false; };
  }, [api, isCitizen]);

  useEffect(() => {
    if (isCitizen || tab !== 'Incident Evidence') return undefined;
    let active = true;
    void api.get<unknown>('/api/rfid/health')
      .then((health) => { if (active) setRfidHealth(health); })
      .catch(() => {
        if (active) setRfidHealth({ status: 'unavailable' });
      });
    return () => { active = false; };
  }, [api, isCitizen, tab]);

  // Background refresh of live dashboards, without spinners or scroll jumps.
  useEffect(() => {
    if (!['Live Camera Feeds', 'Accident Map', 'Crash Incident Radar', 'Evidence Records', 'Pending Verification', 'Junction Overview', 'Overview'].includes(tab)) return undefined;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh({ silent: true });
    }, tab === 'Live Camera Feeds' ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [refresh, tab]);

  const changeTab = (next: Tab, keepSelection = false) => {
    if (next !== tab) {
      setData(null);
      setLoadedTab(null);
    }
    setTab(next);
    setError('');
    setPaymentMessage('');
    setMenuOpen(false);
    if (!keepSelection) {
      if (!['Incident Evidence', 'Crash Incident Report', 'Violation Detail'].includes(next)) setSelectedId('');
      if (!['Vehicle Profile', 'Multi-Junction Tracking'].includes(next)) setSelectedVehicle('');
    }
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    const x = tabPositions.current[next];
    if (typeof x === 'number') tabScrollRef.current?.scrollTo({ x: Math.max(0, x - 24), animated: true });
  };

  const payFine = async (fineId: string, method: PaymentMethod) => {
    if (!fineId || fineId === '—') {
      setPaymentMessage('The fine record did not include an ID.');
      return;
    }
    setBusy(true);
    setPaymentMessage('');
    try {
      const receipt = await api.post<unknown>(
        `/api/citizen/fines/${encodeURIComponent(fineId)}/pay`,
        { method },
      );
      const payment = asRecord(field(asRecord(receipt), 'payment'));
      setPaymentMessage(
        `Payment successful. Receipt ${textValue(field(payment, 'receipt_number', 'reference'))} · ${displayMoney(field(payment, 'amount'))}`,
      );
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      await refresh({ target: 'Pay Fines', silent: true });
    } catch (reason) {
      setPaymentMessage(reason instanceof Error ? reason.message : 'Payment could not be completed.');
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    } finally {
      setBusy(false);
    }
  };

  const pickVideo = async () => {
    setError('');
    try {
      const selection = await DocumentPicker.getDocumentAsync({
        type: ['video/*'],
        copyToCacheDirectory: true,
      });
      if (selection.canceled) return;
      const file = selection.assets[0];
      if (!file) throw new ApiError('The selected video file is unavailable.');
      setBusy(true);
      const uploaded = await api.uploadVideo({
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
      } satisfies VideoAsset);
      setJob(uploaded);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Video upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const resolveIncident = async () => {
    if (!selectedId || !resolvePassword) {
      setResolveMessage('Enter your password to resolve this incident.');
      return;
    }
    setBusy(true);
    setResolveMessage('');
    try {
      await api.post(`/api/incidents/${encodeURIComponent(selectedId)}/resolve`, {
        password: resolvePassword,
        note: resolveNote.trim() || null,
      });
      setResolvePassword('');
      setResolveNote('');
      await refresh({ target: 'Incident Evidence', id: selectedId, silent: true });
    } catch (reason) {
      setResolveMessage(reason instanceof Error ? reason.message : 'Incident could not be resolved.');
    } finally {
      setBusy(false);
    }
  };

  const updateProfile = async () => {
    if (profileName.trim().length < 2) {
      setProfileMessage('Enter your full name (at least 2 characters).');
      return;
    }
    if (profileMobile.trim() && profileMobile.replace(/\D/g, '').length < 7) {
      setProfileMessage('Enter a valid mobile number.');
      return;
    }
    setBusy(true);
    setProfileMessage('');
    try {
      const response = await api.updateProfile({
        name: profileName.trim(),
        mobile: profileMobile.trim() || undefined,
        email: account.email,
      });
      setProfileName(response.name ?? profileName);
      setSavedName(response.name ?? profileName);
      setProfileMobile(response.mobile ?? profileMobile);
      setProfileMessage(`Profile saved for ${textValue(response.name ?? response.email)}.`);
    } catch (reason) {
      setProfileMessage(reason instanceof Error ? reason.message : 'Profile update failed.');
    } finally {
      setBusy(false);
    }
  };

  const markRead = async (id: string | 'all') => {
    setBusy(true);
    setError('');
    try {
      if (id === 'all') await api.post('/api/citizen/notifications/read-all');
      else await api.post(`/api/citizen/notifications/${encodeURIComponent(id)}/read`);
      await refresh({ target: 'Notifications', silent: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Notification update failed.');
    } finally {
      setBusy(false);
    }
  };

  const answerIncident = async (accidentOccurred: boolean, explicitId?: string) => {
    const incidentId = explicitId || confirmationIncidentId || selectedId;
    if (!incidentId) return;
    setBusy(true);
    setConfirmationMessage('');
    try {
      let recorded = accidentOccurred;
      let savedOnServer = true;
      if (portalServer) {
        // The web-portal backend does not take crash-partner answers. Mark the crash notification
        // read so the alarm is not raised again, and tell the person to call for help directly.
        savedOnServer = false;
        const notificationId = crashNotificationIds.current.get(incidentId);
        if (notificationId) {
          await api.post(`/api/citizen/notifications/${encodeURIComponent(notificationId)}/read`).catch(() => undefined);
        }
      } else {
        const response = asRecord(await api.post<unknown>(
          `/api/citizen/incidents/${encodeURIComponent(incidentId)}/confirm`,
          { accident_occurred: accidentOccurred },
        ));
        recorded = field(response, 'accident_occurred') === true;
      }
      answeredIncidents.current.add(incidentId);
      if (recorded) {
        // Keep sending the live location so responders can find the person.
        setSharingIncidentId(incidentId);
        setShareUntil(Date.now() + 60 * 60 * 1000);
      } else if (sharingIncidentId === incidentId) {
        setSharingIncidentId('');
        setShareUntil(null);
      }
      CrashMonitor.cancelAlarm();
      setAlarmPending(false);
      setAlarmMuted(false);
      setConfirmationMessage(
        !savedOnServer
          ? recorded
            ? `This server cannot receive crash answers from the app. Call ${EMERGENCY_NUMBER} now so help is sent.`
            : 'Marked as a false alarm on this phone. Thank you.'
          : recorded
            ? 'Your response was recorded: accident confirmed. Help has been notified through the control room. Call 112 if anyone is injured.'
            : 'Your response was recorded: false alarm. Thank you.',
      );
      if (!savedOnServer && recorded) callEmergency();
      setSelectedId(incidentId);
      changeTab('Crash Incident Report', true);
    } catch (reason) {
      // Keep the alarm running: the person has not been able to answer yet.
      setConfirmationMessage(
        `${reason instanceof Error ? reason.message : 'Could not submit your response.'} The alarm continues until your answer is saved.`,
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!shareUntil) return undefined;
    const timer = setTimeout(() => {
      setSharingIncidentId('');
      setShareUntil(null);
    }, Math.max(0, shareUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [shareUntil]);

  const addVehicle = async () => {
    const plate = newPlate.replace(/\s+/g, '').toUpperCase();
    if (plate.length < 4) {
      setVehicleMessage('Enter the full registration number, for example KA01AB1234.');
      return;
    }
    setBusy(true);
    setVehicleMessage('');
    try {
      await api.addVehicle(plate);
      setNewPlate('');
      setVehicleCount((current) => Math.max(current, 0) + 1);
      setVehicleMessage(`Vehicle ${plate} added. Crash alerts for it will reach this phone.`);
      if (tab === 'Settings' || tab === 'My Vehicles' || tab === 'Dashboard') void refresh({ silent: true });
    } catch (reason) {
      setVehicleMessage(reason instanceof Error ? reason.message : 'Could not add the vehicle.');
    } finally {
      setBusy(false);
    }
  };

  const openMap = (incidentId: string) => {
    setMapIncidentId(incidentId);
    changeTab('Accident Map', true);
  };

  const callEmergency = () => {
    setAlarmMuted(true); // silence the siren during the call; the popup stays until answered
    void Linking.openURL(`tel:${EMERGENCY_NUMBER}`).catch(() => {
      setConfirmationMessage(`Could not open the dialer. Call ${EMERGENCY_NUMBER} from your phone.`);
    });
  };

  const acknowledgeAuthorityAlert = (open: false | 'evidence' | 'map') => {
    const alert = authorityAlerts[0];
    setAuthorityAlerts((current) => current.slice(1));
    CrashMonitor.cancelAlarm();
    setAlarmMuted(false);
    if (open && alert) {
      const id = textValue(field(alert, 'incident_id', 'id'));
      if (id === '—') return;
      if (open === 'map') openMap(id);
      else chooseIncident(id);
    }
  };

  const approveAuthority = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/admin/authority-accounts/${encodeURIComponent(id)}/approve`);
      await refresh({ target: 'Officer Approvals' });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not approve this account.');
    } finally {
      setBusy(false);
    }
  };

  const chooseIncident = (id: string) => {
    setSelectedId(id);
    setResolveMessage('');
    setResolvePassword('');
    changeTab('Incident Evidence', true);
    setTracksData(null);
    void api.get<unknown>(`/api/incidents/${encodeURIComponent(id)}/tracks`)
      .then(setTracksData)
      .catch(() => setTracksData(null));
  };

  const openJunction = (junction: string) => {
    setSelectedJunction(junction);
    changeTab('Junction Evidence', true);
  };

  /** Simple horizontal bars; no chart library needed for a dozen values. */
  const renderBars = (rows: Array<{ label: string; value: number; text: string }>) => {
    const max = Math.max(1, ...rows.map((row) => row.value));
    return rows.map((row) => (
      <View key={row.label} style={styles.barRow}>
        <Text style={styles.barLabel}>{row.label}</Text>
        <View style={styles.barTrack}>
          {row.value > 0 ? <View style={[styles.barFill, { width: `${(row.value / max) * 100}%` }]} /> : null}
        </View>
        <Text style={styles.barValue}>{row.text}</Text>
      </View>
    ));
  };

  const shareFinesCsv = async (rows: unknown[], year: string) => {
    const columns = ['reference', 'id', 'plate_number', 'violation_type', 'amount', 'status', 'issued_at', 'paid_at'];
    const escape = (value: unknown) => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => escape(asRecord(row)[key])).join(','))].join('\n');
    try {
      await Share.share({ title: `AGHAT SETHU fines ${year}.csv`, message: csv });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not share the summary.');
    }
  };

  const renderGenericList = (value: unknown, keys: string[] = [], emptyText = 'No records returned by the server.') => {
    const list = asList(value, keys);
    if (list.length === 0) return <Empty text={emptyText} />;
    return list.map((item, index) => {
      const record = asRecord(item);
      const id = recordId(record);
      return (
        <DataCard
          api={api}
          key={`${id}-${index}`}
          onSelect={!isCitizen && id !== '—' ? () => chooseIncident(id) : undefined}
          value={item}
        />
      );
    });
  };

  const renderAddVehicle = (prompt: boolean) => (
    <Card>
      <Text style={styles.cardTitle}>{prompt ? 'Add your vehicle to get crash alerts' : 'Add a vehicle'}</Text>
      <Text style={styles.bodyText}>
        {prompt
          ? 'Crash alerts are matched to vehicles by number plate. Add the vehicle you drive so the alarm reaches you if it is in an accident.'
          : 'Register another vehicle you own or drive.'}
      </Text>
      <Input
        autoCapitalize="characters"
        label="Vehicle registration number"
        maxLength={20}
        onChangeText={(value) => setNewPlate(value.toUpperCase())}
        onSubmitEditing={() => void addVehicle()}
        placeholder="KA01AB1234"
        returnKeyType="done"
        value={newPlate}
      />
      {vehicleMessage ? <Text style={vehicleMessage.startsWith('Vehicle ') ? styles.successText : styles.errorText}>{vehicleMessage}</Text> : null}
      <Button disabled={busy} onPress={() => void addVehicle()} title="Add vehicle" />
    </Card>
  );

  /** Live-location status while a crash involving this citizen is open. */
  const renderLocationShare = (onAlarm: boolean) => {
    if (!isCitizen || !sharingIncidentId || portalServer) return null;
    const textStyle = onAlarm ? styles.alarmDetail : styles.bodyText;
    if (!settings.shareLocation) {
      return <Text style={textStyle}>Live location sharing is off in Settings. Responders only see the crash location.</Text>;
    }
    const status = locationShare.stopped
      ? `Location sharing stopped: ${locationShare.stopped}`
      : locationShare.status === 'denied'
        ? 'Location permission is off, so responders cannot see where you are. Allow location for AGHAT SETHU in phone settings.'
        : locationShare.status === 'error'
          ? `Could not read your location: ${locationShare.error}`
          : locationShare.lastSentAt
            ? `📍 Sharing your live location with responders (last sent ${new Date(locationShare.lastSentAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}).`
            : '📍 Getting your location to share with responders…';
    return (
      <>
        <Text style={[textStyle, locationShare.status === 'denied' && !onAlarm && styles.errorText]}>{status}</Text>
        {!onAlarm && shareUntil && !locationShare.stopped ? (
          <Button
            compact
            onPress={() => {
              setSharingIncidentId('');
              setShareUntil(null);
            }}
            secondary
            title="Stop sharing my location"
          />
        ) : null}
      </>
    );
  };

  const themeOptions: Array<{ value: ThemeMode; label: string }> = [
    { value: 'system', label: 'Use phone setting' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  const renderSettings = () => {
    const me = asRecord(data);
    const vehicles = asList(field(me, 'vehicles'));
    return (
      <View style={styles.stack}>
        <ScreenTitle title="Settings" caption="Appearance, profile, alerts and account." />

        <SectionLabel>Appearance</SectionLabel>
        <Card>
          <Text style={styles.cardTitle}>Theme</Text>
          <Text style={styles.caption}>
            {settings.themeMode === 'system' ? `Following the phone (currently ${settings.scheme}).` : `Always ${settings.themeMode}.`}
          </Text>
          <View style={styles.methodRow}>
            {themeOptions.map((option) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: settings.themeMode === option.value }}
                key={option.value}
                onPress={() => settings.setThemeMode(option.value)}
                style={[styles.methodButton, settings.themeMode === option.value && styles.methodButtonActive]}
              >
                <Text style={[styles.methodText, settings.themeMode === option.value && styles.methodTextActive]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <SectionLabel>Profile</SectionLabel>
        <Card>
          <Input autoCapitalize="words" autoComplete="name" label="Full name" maxLength={120} onChangeText={setProfileName} value={profileName} />
          <Input
            autoComplete="tel"
            hint={isCitizen ? 'Responders can call this number if you are in a crash.' : undefined}
            keyboardType="phone-pad"
            label="Mobile"
            maxLength={30}
            onChangeText={setProfileMobile}
            value={profileMobile}
          />
          <Text style={styles.caption}>Email: {textValue(account.email)}</Text>
          {profileMessage ? <Text style={profileMessage.startsWith('Profile saved') || profileMessage.endsWith('allowed.') ? styles.successText : styles.errorText}>{profileMessage}</Text> : null}
          <Button disabled={busy} onPress={() => void updateProfile()} title="Save profile" />
        </Card>

        {isCitizen ? (
          <>
            <SectionLabel>Vehicles</SectionLabel>
            {vehicles.length > 0 ? (
              <Card>
                <Text style={styles.cardTitle}>Registered vehicles</Text>
                <View style={[styles.methodRow, styles.plateRow]}>
                  {vehicles.map((vehicle, index) => (
                    <View key={index} style={styles.plateChip}>
                      <Text style={styles.plateChipText}>{textValue(field(asRecord(vehicle), 'plate_number', 'plate'))}</Text>
                    </View>
                  ))}
                </View>
              </Card>
            ) : null}
            {renderAddVehicle(vehicles.length === 0)}
          </>
        ) : null}

        <SectionLabel>Crash alerts</SectionLabel>
        <Card>
          <Text style={styles.cardTitle}>Crash alarm</Text>
          <Text style={styles.bodyText}>
            {isCitizen
              ? 'When a crash involving your vehicle is reported, minor or major, AGHAT SETHU sounds a loud alarm and shows a full-screen alert until you confirm whether you are safe.'
              : 'Every new crash sounds a loud alarm until you acknowledge it. Open the accident map from the alert to see the location and route.'}
          </Text>
          <Button onPress={() => void requestNotificationPermission().then((granted) => setProfileMessage(granted ? 'Notifications are allowed.' : 'Notifications are blocked. Allow them in Android Settings › Apps › AGHAT SETHU.'))} secondary title="Check notification permission" />
        </Card>
        {isCitizen ? (
          <Card>
            <View style={styles.cardHeading}>
              <Text style={[styles.cardTitle, styles.shrink]}>Share my live location in a crash</Text>
              <Switch
                accessibilityLabel="Share my live location in a crash"
                onValueChange={settings.setShareLocation}
                thumbColor={settings.shareLocation ? colors.primary : colors.surface}
                trackColor={{ false: colors.borderStrong, true: colors.primarySoft }}
                value={settings.shareLocation}
              />
            </View>
            <Text style={styles.bodyText}>
              While a crash alarm is open, and for up to an hour after you answer “Yes, I need help”, your phone sends its location to
              the control room and responders so they can reach you quickly. Nothing is shared at other times.
            </Text>
            {renderLocationShare(false)}
          </Card>
        ) : null}
        <BackgroundAlarmCard />

        <SectionLabel>Account</SectionLabel>
        <Card>
          <Text style={styles.cardTitle}>{labelForRole(role)} account</Text>
          <Text style={styles.caption}>Signed in as {textValue(account.email)}</Text>
          <Text style={styles.caption}>Server: {api.getBaseUrl()}</Text>
          <Text style={styles.caption}>App version {Constants.expoConfig?.version ?? '—'}</Text>
          <Button danger onPress={() => void onLogout()} title="Sign out" />
        </Card>
      </View>
    );
  };

  const renderCitizen = () => {
    if (tab === 'Settings') return renderSettings();
    if (tab === 'My Vehicles') {
      const accountVehicles = asList(data, ['vehicles']);
      return (
        <View style={styles.stack}>
          <ScreenTitle title="My vehicles" caption="Vehicles registered to your citizen account." />
          {accountVehicles.length > 0
            ? accountVehicles.map((vehicle, index) => <DataCard api={api} key={`${recordId(asRecord(vehicle))}-${index}`} value={vehicle} />)
            : <Empty text="No registered vehicles were returned for this account." />}
        </View>
      );
    }
    if (tab === 'Payment History') {
      return <View style={styles.stack}><ScreenTitle title="Payment history" caption="Receipts from the (simulated) payment gateway." />{renderGenericList(data, ['payments'], 'No payments yet.')}</View>;
    }
    if (tab === 'Notifications') {
      const allNotifications = asList(data, ['notifications']);
      const list = allNotifications.filter((item) => {
        const record = asRecord(item);
        const kind = String(field(record, 'kind', 'type') ?? '').toLowerCase();
        if (notificationFilter === 'Unread') return !field(record, 'read_at', 'read');
        if (notificationFilter === 'E-challan') return kind.includes('fine') || kind.includes('challan');
        if (notificationFilter === 'Crash') return kind.includes('crash');
        return true;
      });
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Notifications" caption="Alerts for your account and vehicles." />
          <Chips onChange={setNotificationFilter} options={['All', 'Unread', 'E-challan', 'Crash'] as const} value={notificationFilter} />
          {allNotifications.length > 0 ? <Button disabled={busy} onPress={() => void markRead('all')} secondary title="Mark all as read" /> : null}
          {list.length === 0 ? <Empty text="No notifications in this view." /> : list.map((item, index) => {
            const record = asRecord(item);
            const id = recordId(record);
            const incidentId = textValue(field(record, 'incident_id', 'reference_id'));
            const kind = String(field(record, 'kind', 'type') ?? '');
            const unread = !field(record, 'read_at');
            return (
              <DataCard api={api} key={`${id}-${index}`} value={item}>
                <View style={styles.inlineButtons}>
                  {unread ? <Button compact disabled={busy} onPress={() => void markRead(id)} secondary title="Mark read" /> : null}
                  {kind.toLowerCase().includes('crash') && incidentId !== '—' ? (
                    <Button compact onPress={() => {
                      setSelectedId(incidentId);
                      changeTab('Crash Incident Report', true);
                    }} title="Open incident report" />
                  ) : null}
                </View>
              </DataCard>
            );
          })}
        </View>
      );
    }
    if (tab === 'Crash Incident Report') {
      const incident = asRecord(data);
      const response = asRecord(field(incident, 'response'));
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Crash incident report" caption="Citizen view excludes camera frames and RFID data." />
          {confirmationMessage ? <Card><Text style={styles.successText}>{confirmationMessage}</Text></Card> : null}
          {selectedId && sharingIncidentId === selectedId ? <Card>{renderLocationShare(false)}</Card> : null}
          {selectedId ? (
            <>
              <DataCard api={api} value={data} />
              <Card>
                {field(incident, 'response') ? (
                  <Text style={styles.successText}>
                    You reported: {field(response, 'accident_occurred') === true ? 'accident confirmed' : 'false alarm'} ({displayDate(field(response, 'responded_at'))}).
                  </Text>
                ) : (
                  <>
                    <Text style={styles.noticeText}>Please confirm whether this incident involved you.</Text>
                    <Button danger disabled={busy} onPress={() => void answerIncident(true, selectedId)} title="Yes, an accident happened" />
                    <HoldButton disabled={busy} onConfirm={() => void answerIncident(false, selectedId)} title="No, false alarm — I'm safe" />
                  </>
                )}
                <Button onPress={callEmergency} secondary title={`Call emergency services (${EMERGENCY_NUMBER})`} />
              </Card>
            </>
          ) : <Empty text="Open a report from a crash notification in the Notifications section." />}
        </View>
      );
    }
    if (tab === 'Pay Fines' || tab === 'My Violations') {
      const all = asList(data, ['fines', 'violations']);
      const list = tab === 'Pay Fines'
        ? all.filter((fine) => String(field(asRecord(fine), 'status') ?? '').toLowerCase() !== 'paid')
        : all;
      return (
        <View style={styles.stack}>
          <ScreenTitle
            title={tab === 'Pay Fines' ? 'Pay fines' : 'Traffic e-challan history'}
            caption={tab === 'Pay Fines' ? 'Unpaid e-challans for your vehicles. Payments use a simulated gateway.' : 'All e-challans issued to your vehicles.'}
          />
          {paymentMessage ? <Card><Text style={paymentMessage.startsWith('Payment successful') ? styles.successText : styles.errorText}>{paymentMessage}</Text></Card> : null}
          {list.length === 0
            ? <Empty text={tab === 'Pay Fines' ? 'You have no unpaid fines.' : 'No e-challans have been issued to your vehicles.'} />
            : list.map((fine, index) => (
              <PaymentFineCard api={api} fine={fine} key={`${recordId(asRecord(fine))}-${index}`} onPayment={payFine} />
            ))}
        </View>
      );
    }
    if (tab === 'Dashboard') {
      const fines = asList(data, ['fines']);
      const summary = asRecord(data);
      return (
        <View style={styles.stack}>
          <ScreenTitle title={`Welcome back${savedName ? `, ${savedName}` : ''}`} caption="Citizen dashboard · Bengaluru traffic services" />
          {vehicleCount === 0 ? renderAddVehicle(true) : null}
          <View style={styles.metricRow}>
            <Metric label="Registered vehicles" value={textValue(field(summary, 'registered_vehicles'))} />
            <Metric label="Fines issued" value={textValue(field(summary, 'fines_issued'))} />
          </View>
          <View style={styles.metricRow}>
            <Metric label="Unpaid fines" tone={Number(field(summary, 'unpaid_fines') ?? 0) > 0 ? 'bad' : 'good'} value={textValue(field(summary, 'unpaid_fines'))} />
            <Metric label="Total unpaid" value={displayMoney(field(summary, 'total_unpaid'))} />
          </View>
          <View style={styles.inlineButtons}>
            <Button compact onPress={() => changeTab('Pay Fines')} title="Pay fines" />
            <Button compact onPress={() => changeTab('My Vehicles')} secondary title="My vehicles" />
            <Button compact onPress={() => changeTab('Notifications')} secondary title="Notifications" />
          </View>
          <SectionLabel>Recent e-challans</SectionLabel>
          {fines.length
            ? fines.slice(0, 5).map((fine, index) => <DataCard api={api} key={`${recordId(asRecord(fine))}-${index}`} value={fine} />)
            : <Empty text="No e-challans have been issued to your vehicles." />}
        </View>
      );
    }
    return <Empty text="Select a citizen section." />;
  };

  const renderCameraGrid = () => {
    const listed = asList(data, ['cameras', 'junctions', 'items']);
    const cameras = listed.length ? listed : JUNCTIONS.map((junction) => ({ junction_id: junction, status: frameData[junction] ? 'online' : 'offline' }));
    return (
      <View style={styles.stack}>
        <ScreenTitle
          title="Live camera feeds"
          caption={liveError || (streams?.enabled
            ? 'WebRTC video from the junction cameras, with the latest frame shown while video connects.'
            : 'Frames and crash events arrive from the backend live-camera WebSocket.')}
        />
        {cameras.length === 0
          ? <Empty text="The backend has no configured camera junctions." />
          : cameras.map((camera, index) => {
          const record = asRecord(camera);
          const id = textValue(typeof camera === 'string' ? camera : field(record, 'junction_id', 'id', 'name') ?? `Camera ${index + 1}`);
          const frame = frameData[id];
          const status = frame || field(record, 'connected') === true || String(field(record, 'status') ?? '').toLowerCase() === 'online'
            ? 'online'
            : 'offline';
          const whep = streams?.enabled ? streams.whep[id] : undefined;
          const still = frame ? (
            <Image source={{ uri: frame }} style={styles.cameraFrame} resizeMode="contain" />
          ) : (
            <View style={styles.cameraEmpty}>
              <Text style={styles.cameraEmptyText}>
                {status === 'online' ? 'Camera online; waiting for a frame' : 'Camera offline; no recent frame'}
              </Text>
            </View>
          );
          return (
            <Card key={id} style={styles.cameraCard}>
              <View style={styles.cardHeading}>
                <Text style={[styles.cardTitle, styles.cameraTitle]}>{id}</Text>
                <Tag tone={status === 'online' ? 'good' : 'bad'}>{videoStatus[id] === 'live' ? 'webrtc' : status}</Tag>
              </View>
              {whep ? (
                <LiveVideo
                  fallback={still}
                  iceServers={streams?.iceServers ?? []}
                  onStatus={(next) => setVideoStatus((current) => (current[id] === next ? current : { ...current, [id]: next }))}
                  whepUrl={whep}
                />
              ) : still}
              {typeof field(record, 'last_frame_age_s') === 'number'
                ? <Text style={styles.caption}>Last frame {textValue(field(record, 'last_frame_age_s'))} seconds ago</Text>
                : null}
            </Card>
          );
        })}
        {liveEvent ? <DataCard api={api} value={liveEvent} /> : <Empty text="Waiting for live events. This backend authenticates the camera socket with the signed-in authority token." />}
        <Card>
          <Text style={styles.cardTitle}>Live plate detections</Text>
          {livePlateEvents.length === 0
            ? <Text style={styles.caption}>No live plate-detection events have been received. Live ANPR may be disabled on the backend.</Text>
            : livePlateEvents.map((event, index) => <DataCard api={api} key={index} value={event} />)}
        </Card>
      </View>
    );
  };

  const renderAuthority = () => {
    if (tab === 'Settings') return renderSettings();
    if (tab === 'Accident Map') {
      const unresolved = listField(data, 'unresolved');
      const located = unresolved.filter((item) => mapIncident(item).location);
      return (
        <View style={styles.stack}>
          <ScreenTitle
            title="Accident map"
            caption={`${unresolved.length} open crash${unresolved.length === 1 ? '' : 'es'}. Live positions refresh every 5 seconds.`}
          />
          {unresolved.length === 0 ? <Empty text="No crashes are open right now. New crashes appear here and sound the alarm." /> : null}
          {unresolved.length > 0 && located.length === 0 ? (
            <Empty text="Open crashes have no location yet. Set JUNCTION_COORDINATES on the server, or send latitude/longitude with crash events." />
          ) : null}
          {unresolved.length > 0 ? (
            <IncidentMap
              api={api}
              incidents={unresolved}
              onOpenEvidence={chooseIncident}
              onSelect={setMapIncidentId}
              selectedId={mapIncidentId}
            />
          ) : null}
        </View>
      );
    }
    if (tab === 'Live Camera Feeds') return renderCameraGrid();
    if (tab === 'Junction Overview') {
      const junctions = asList(data, ['junctions', 'items']);
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Junction overview" caption="Instrumented junctions with crash and RFID sighting totals." />
          {junctions.length
            ? junctions.map((item, index) => <DataCard api={api} key={`${recordId(asRecord(item))}-${index}`} value={item} />)
            : <Empty text="No junction records are configured." />}
        </View>
      );
    }
    if (tab === 'Vehicle Registry & Search') {
      const vehicles = asList(data, ['items', 'vehicles']);
      const runSearch = () => setVehicleSearch(vehicleSearchDraft.trim());
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Vehicle registry and search" caption="Search by plate or FASTag ID, then open a profile or its junction tracks." />
          <Card>
            <Input
              autoCapitalize="characters"
              label="Plate or FASTag ID"
              onChangeText={setVehicleSearchDraft}
              onSubmitEditing={runSearch}
              placeholder="KA01AB1234"
              returnKeyType="search"
              value={vehicleSearchDraft}
            />
            <Button disabled={busy} onPress={runSearch} title="Search vehicles" />
          </Card>
          {vehicles.length ? vehicles.map((item, index) => {
            const vehicle = asRecord(item);
            const plate = textValue(field(vehicle, 'plate_number', 'plate'));
            return <DataCard api={api} key={`${plate}-${index}`} onSelect={() => {
              setSelectedVehicle(plate);
              changeTab('Vehicle Profile', true);
            }} value={item} />;
          }) : <Empty text={vehicleSearch ? `No registered vehicles match “${vehicleSearch}”.` : 'No registered vehicles.'} />}
        </View>
      );
    }
    if (tab === 'Vehicle Profile' || tab === 'Multi-Junction Tracking') {
      const tracks = asList(data, ['items', 'sightings', 'tracks']);
      const profile = asRecord(data);
      const { sightings: _sightings, ...profileFields } = profile;
      return (
        <View style={styles.stack}>
          <ScreenTitle title={tab === 'Vehicle Profile' ? 'Vehicle profile' : 'Multi-junction tracking'} caption={selectedVehicle || 'Select a vehicle from Vehicle Registry & Search.'} />
          {!selectedVehicle ? (
            <Button onPress={() => changeTab('Vehicle Registry & Search')} title="Search vehicles" />
          ) : tab === 'Vehicle Profile' ? (
            <>
              {data ? <DataCard api={api} value={profileFields} /> : null}
              <Button onPress={() => changeTab('Multi-Junction Tracking', true)} title="View junction tracks" />
              <SectionLabel>Junction sightings</SectionLabel>
              {listField(profile, 'sightings').length
                ? listField(profile, 'sightings').map((item, index) => <DataCard api={api} key={index} onSelect={() => chooseIncident(textValue(field(asRecord(item), 'incident_id')))} value={item} />)
                : <Empty text="No RFID sightings are recorded for this vehicle." />}
            </>
          ) : tracks.length ? tracks.map((item, index) => <DataCard api={api} key={index} onSelect={() => chooseIncident(textValue(field(asRecord(item), 'incident_id')))} value={item} />)
            : <Empty text="No incident or RFID sightings are recorded for this vehicle." />}
        </View>
      );
    }
    if (tab === 'Violation Detail') {
      const detail = asRecord(data);
      const evidence = field(detail, 'evidence_url', 'image_url');
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Violation detail" caption={selectedId ? `Fine record ${selectedId}` : 'Select a fine from Fines & Revenue.'} />
          {selectedId ? (
            <>
              <DataCard api={api} value={data} />
              {typeof evidence === 'string'
                ? <Card><Text style={styles.cardTitle}>Evidence</Text><ProtectedImage api={api} path={evidence} /></Card>
                : <Empty text="No evidence image is attached to this fine." />}
            </>
          ) : <Button onPress={() => changeTab('Fines & Revenue')} title="Open Fines & Revenue" />}
        </View>
      );
    }
    if (tab === 'Officer Approvals' && (role === 'admin' || role === 'super_admin')) {
      const accounts = asList(data, ['items', 'accounts']);
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Officer approvals" caption="Approve pending authority accounts before they can sign in." />
          {accounts.length ? accounts.map((item, index) => {
            const officer = asRecord(item);
            const id = recordId(officer);
            const pending = String(field(officer, 'status') ?? '').toLowerCase().includes('pending');
            return <DataCard api={api} key={`${id}-${index}`} value={item}>
              {pending ? <Button disabled={busy} onPress={() => void approveAuthority(id)} title="Approve officer" /> : null}
            </DataCard>;
          }) : <Empty text="No authority accounts are waiting for review." />}
        </View>
      );
    }
    if (tab === 'Routine Violations') {
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Routine violations · Level 1" caption="Upload a traffic video to the server’s analysis pipeline." />
          <Card>
            <Text style={styles.bodyText}>The server runs violation detection, plate OCR and fine generation. Results are not generated on the phone.</Text>
            <Button disabled={busy} onPress={() => void pickVideo()} title={busy ? 'Uploading…' : 'Choose and upload a traffic video'} />
          </Card>
          {job ? <VideoJob api={api} job={job} /> : <Empty text="No video has been submitted in this session." />}
        </View>
      );
    }
    if (tab === 'Incident Evidence') {
      const detail = asRecord(data);
      const plates = listField(detail, 'involved_vehicles');
      const rfid = listField(detail, 'crash_zone_rfid_snapshot');
      const confirmations = asRecord(field(detail, 'citizen_confirmations'));
      const sightings = listField(detail, 'sightings');
      const evidence = listField(detail, 'evidence');
      const tracks = listField(tracksData, 'tracks');
      const {
        timeline: _timeline,
        crash_zone_rfid_snapshot: _rfid,
        citizen_confirmations: _confirmations,
        sightings: _sightingList,
        evidence: _evidence,
        involved_vehicles: _vehicles,
        routes: _routes,
        ...summary
      } = detail;
      const routes = routesFor(detail);
      const rfidStatus = String(field(asRecord(rfidHealth), 'status') ?? 'checking');
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Incident evidence" caption={selectedId ? `Incident ${selectedId}` : 'Select an incident below or from the Crash Incident Radar.'} />
          <Card>
            <View style={styles.cardHeading}>
              <Text style={styles.cardTitle}>RFID service</Text>
              <Tag tone={rfidStatus === 'online' ? 'good' : rfidStatus === 'checking' ? 'neutral' : 'bad'}>{rfidStatus}</Tag>
            </View>
            <Text style={styles.caption}>Last report: {displayDate(field(asRecord(rfidHealth), 'last_report_at'))}</Text>
          </Card>
          {selectedId && data ? (
            <>
              <DataCard api={api} value={summary} />
              {evidence.map((item, index) => {
                const url = field(asRecord(item), 'url');
                return typeof url === 'string'
                  ? <Card key={index}><Text style={styles.cardTitle}>Crash frame</Text><ProtectedImage api={api} path={url} /></Card>
                  : null;
              })}
              <SectionLabel>Vehicles involved</SectionLabel>
              {plates.length
                ? <View style={styles.inlineButtons}>{plates.map((plate, index) => (
                  <Pressable accessibilityRole="button" key={index} onPress={() => { setSelectedVehicle(String(plate)); changeTab('Vehicle Profile', true); }} style={styles.plateChip}>
                    <Text style={styles.plateChipText}>{textValue(plate)}</Text>
                  </Pressable>
                ))}</View>
                : <Text style={styles.caption}>No plates identified yet.</Text>}
              <SectionLabel>Multi-junction tracking</SectionLabel>
              {routes.length ? routes.map((route) => (
                <Card key={route.plate}>
                  <View style={styles.cardHeading}>
                    <Text style={[styles.cardTitle, styles.shrink]}>{route.plate}</Text>
                    {route.fled ? <Tag tone="bad">FLED</Tag> : <Tag>involved</Tag>}
                  </View>
                  {route.owner ? <Text style={styles.caption}>Owner: {route.owner}</Text> : null}
                  {route.steps.map((step, index) => (
                    <Pressable
                      accessibilityHint="Opens the evidence recorded at this junction"
                      accessibilityRole="button"
                      key={`${step.junction}-${index}`}
                      onPress={() => openJunction(step.junction)}
                      style={({ pressed }) => [styles.routeStep, pressed && styles.pressedCard]}
                    >
                      <Text style={styles.routeIndex}>{index + 1}</Text>
                      <View style={styles.shrink}>
                        <Text style={styles.dataStrong}>{step.junction} →</Text>
                        <Text style={styles.caption}>
                          {step.kind === 'crash' ? 'Crash recorded' : VERDICT_LABELS[step.verdict ?? ''] ?? step.verdict ?? 'Camera verifying…'}
                          {step.at ? ` · ${displayDate(step.at)}` : ''}
                          {step.reports ? ` · ${step.reports} RFID report(s)` : ''}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                  {route.steps.length <= 1 ? (
                    <Text style={styles.caption}>
                      {route.epc ? 'Not read at another junction yet.' : 'No RFID tag registered: this vehicle cannot be tracked by RFID.'}
                    </Text>
                  ) : null}
                </Card>
              )) : <Empty text="No involved vehicle was identified for this crash." />}
              <View style={styles.inlineButtons}>
                {JUNCTIONS.map((junction) => (
                  <Button compact key={junction} onPress={() => openJunction(junction)} secondary title={`${junction} evidence`} />
                ))}
              </View>
              <SectionLabel>Citizen crash confirmations</SectionLabel>
              <View style={styles.metricRow}>
                <Metric label="Responses" value={textValue(field(confirmations, 'responses'))} />
                <Metric label="Accident confirmed" tone="bad" value={textValue(field(confirmations, 'accident_confirmed'))} />
                <Metric label="False alarm" tone="good" value={textValue(field(confirmations, 'false_alarm_reported'))} />
              </View>
              <SectionLabel>RFID tags read at the crash junction</SectionLabel>
              {rfid.length ? rfid.map((item, index) => <DataCard api={api} key={index} value={item} />) : <Empty text="No RFID tags were read near this crash." />}
              <SectionLabel>Next-junction sightings</SectionLabel>
              {sightings.length ? sightings.map((item, index) => {
                const { payload: _payload, ...sighting } = asRecord(item);
                return <DataCard api={api} key={index} value={sighting} />;
              }) : <Empty text="The involved vehicles have not been read at another junction yet." />}
              {tracks.length ? (
                <>
                  <SectionLabel>Multi-junction track</SectionLabel>
                  {tracks.map((item, index) => <DataCard api={api} key={index} value={item} />)}
                </>
              ) : null}
              {String(field(detail, 'status') ?? '') !== 'resolved' ? (
                <Card>
                  <Text style={styles.cardTitle}>Resolve incident</Text>
                  <Text style={styles.caption}>Re-enter your password to confirm.</Text>
                  <Input label="Note (optional)" maxLength={2000} onChangeText={setResolveNote} placeholder="What was done at the scene" value={resolveNote} />
                  <Input autoCapitalize="none" autoComplete="password" label="Password" onChangeText={setResolvePassword} onSubmitEditing={() => void resolveIncident()} returnKeyType="done" secureTextEntry value={resolvePassword} />
                  {resolveMessage ? <Text style={styles.errorText}>{resolveMessage}</Text> : null}
                  <Button danger disabled={busy || !resolvePassword} onPress={() => void resolveIncident()} title="Resolve incident" />
                </Card>
              ) : null}
              <Button onPress={() => { setSelectedId(''); setTracksData(null); }} secondary title="Back to all incidents" />
            </>
          ) : selectedId ? null : renderGenericList(data, ['incidents', 'items'], 'No incidents have been recorded.')}
        </View>
      );
    }
    if (tab === 'Junction Evidence') {
      const detail = asRecord(data);
      const incident = asRecord(field(detail, 'incident'));
      const junction = asRecord(field(detail, 'junction'));
      const frames = listField(detail, 'crash_frames');
      const vehicles = listField(detail, 'vehicles');
      const imagesOf = (value: unknown): string[] => {
        const record = asRecord(value);
        const evidence = asRecord(field(record, 'evidence'));
        const primary = asRecord(field(evidence, 'primary'));
        const supporting = listField(asRecord(field(evidence, 'supporting')), 'images');
        return [primary, ...supporting.map(asRecord), ...listField(record, 'images').map(asRecord)]
          .map((item) => field(item, 'url'))
          .filter((url): url is string => typeof url === 'string');
      };
      return (
        <View style={styles.stack}>
          <ScreenTitle
            title={`${textValue(field(junction, 'label') ?? selectedJunction)} · ${textValue(field(incident, 'reference') ?? selectedId)}`}
            caption="Evidence recorded at this junction for the selected crash."
          />
          <View style={styles.inlineButtons}>
            {JUNCTIONS.map((item) => (
              <Button compact key={item} onPress={() => setSelectedJunction(item)} secondary={item !== selectedJunction} title={item} />
            ))}
            <Button compact onPress={() => changeTab('Incident Evidence', true)} secondary title="← Incident evidence" />
          </View>
          {!selectedId ? <Empty text="Open an incident first, then choose a junction from its tracking route." /> : (
            <>
              {field(junction, 'is_crash') === true ? <Tag tone="bad">CRASH JUNCTION</Tag> : null}
              {frames.length ? (
                <Card>
                  <Text style={styles.cardTitle}>Crash frames</Text>
                  {frames.map((item, index) => {
                    const url = field(asRecord(item), 'url');
                    return typeof url === 'string' ? <ProtectedImage api={api} key={index} path={url} /> : null;
                  })}
                </Card>
              ) : null}
              {vehicles.length ? vehicles.map((item, index) => {
                const vehicle = asRecord(item);
                const { evidence: _evidence, sightings, ...rest } = vehicle;
                return (
                  <DataCard api={api} key={index} value={rest}>
                    {imagesOf(vehicle).slice(0, 4).map((url) => <ProtectedImage api={api} key={url} path={url} />)}
                    {Array.isArray(sightings) && sightings.length ? (
                      <Text style={styles.caption}>Sighted here at {sightings.map((sighting) => displayDate(field(asRecord(sighting), 'seen_at'))).join(', ')}</Text>
                    ) : null}
                  </DataCard>
                );
              }) : (
                data ? <Empty text={`No involved vehicle has been read at ${selectedJunction} yet.`} /> : null
              )}
            </>
          )}
        </View>
      );
    }
    if (tab === 'Crash Incident Radar' || tab === 'Evidence Records' || tab === 'Pending Verification') {
      const unresolved = tab === 'Crash Incident Radar' ? listField(data, 'unresolved') : [];
      const resolvedToday = tab === 'Crash Incident Radar' ? listField(data, 'resolved_today') : [];
      const list = tab === 'Pending Verification'
        ? asList(data, ['items', 'pending_verifications', 'verifications'])
        : tab === 'Crash Incident Radar'
          ? [...unresolved, ...resolvedToday]
          : asList(data, ['incidents', 'items']);
      const captions: Record<string, string> = {
        'Crash Incident Radar': `${unresolved.length} unresolved · ${resolvedToday.length} resolved today. Tap an incident for its evidence.`,
        'Evidence Records': 'All recorded incidents. Tap one to open its evidence.',
        'Pending Verification': 'Partial plates waiting for manual verification.',
      };
      return (
        <View style={styles.stack}>
          <ScreenTitle title={tab} caption={captions[tab]} />
          {list.length === 0 ? <Empty text={tab === 'Crash Incident Radar' ? 'No crashes are active right now.' : 'Nothing to show yet.'} /> : list.map((item, index) => {
            const record = asRecord(item);
            const id = recordId(record);
            const { timeline: _timeline, ...display } = record;
            return (
              <DataCard api={api} key={`${id}-${index}`} onSelect={tab === 'Pending Verification' || id === '—' ? undefined : () => chooseIncident(id)} value={display}>
                {tab === 'Pending Verification' && id !== '—' ? (
                  <ProtectedImage api={api} path={`/api/authority/pending-verifications/${encodeURIComponent(id)}/snapshot`} />
                ) : null}
                {tab === 'Crash Incident Radar' && String(field(record, 'status') ?? '') !== 'resolved' ? (
                  <View style={styles.inlineButtons}>
                    <Button compact onPress={() => openMap(id)} title="Open on map" />
                    <Button compact onPress={() => chooseIncident(id)} secondary title="Incident evidence" />
                    <Button compact onPress={() => changeTab('Live Camera Feeds')} secondary title="View live feed" />
                  </View>
                ) : null}
              </DataCard>
            );
          })}
        </View>
      );
    }
    if (tab === 'Fines & Revenue') {
      const response = asRecord(data);
      const fineRows = asList(response, ['items']);
      const monthly = listField(response, 'monthly');
      const commitYear = (value: string) => {
        const digits = value.replace(/\D/g, '').slice(0, 4);
        setFinesYearDraft(digits);
        if (digits.length === 4) setFinesYear(digits);
      };
      return (
        <View style={styles.stack}>
          <ScreenTitle title={tab} caption={`E-challans and collections for ${finesYear}.`} />
          <Card>
            <Chips onChange={setFineFilter} options={['All', 'Paid', 'Unpaid'] as const} value={fineFilter} />
            <Input keyboardType="number-pad" label="Year" maxLength={4} onChangeText={commitYear} value={finesYearDraft} />
          </Card>
          <View style={styles.metricRow}>
            <Metric label="Fines issued" value={textValue(field(response, 'fines_issued'))} />
            <Metric label="Revenue collected" tone="good" value={displayMoney(field(response, 'revenue_collected'))} />
            <Metric label="Pending" tone="bad" value={displayMoney(field(response, 'pending_amount'))} />
          </View>
          <SectionLabel>Revenue collected per month</SectionLabel>
          {monthly.length ? (
            <Card>
              {renderBars(monthly.map((month) => {
                const item = asRecord(month);
                const number = Number(field(item, 'month'));
                const amount = Number(field(item, 'collected', 'revenue_collected', 'amount') ?? 0);
                return {
                  label: Number.isInteger(number) && number >= 1 && number <= 12 ? MONTHS[number - 1] : textValue(field(item, 'month')),
                  value: Number.isFinite(amount) ? amount : 0,
                  text: displayMoney(amount),
                };
              }))}
            </Card>
          ) : <Empty text="No fines were issued in this year." />}
          {fineRows.length ? (
            <Button onPress={() => void shareFinesCsv(fineRows, finesYear)} secondary title="Share summary (CSV)" />
          ) : null}
          <SectionLabel>{`Fine records · ${textValue(field(response, 'total'))} matching`}</SectionLabel>
          {fineRows.length
            ? fineRows.map((fine, index) => <DataCard api={api} key={`${recordId(asRecord(fine))}-${index}`} onSelect={() => {
              setSelectedFine(fine);
              setSelectedId(recordId(asRecord(fine)));
              changeTab('Violation Detail', true);
            }} value={fine} />)
            : <Empty text="No fines match this filter." />}
        </View>
      );
    }
    if (tab === 'Overview') {
      const summary = asRecord(data);
      const latestFrame = field(summary, 'latest_crash_frame');
      const byType = Object.entries(asRecord(field(summary, 'violations_by_type')));
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Tactical operations centre" caption="Live summary from the authority service." />
          <BackgroundAlarmCard />
          {data ? (
            <>
              <View style={styles.metricRow}>
                <Metric label="Crashes detected" value={textValue(field(summary, 'crashes_detected'))} />
                <Metric label="Unresolved crashes" tone={Number(field(summary, 'unresolved_crashes') ?? 0) > 0 ? 'bad' : 'good'} value={textValue(field(summary, 'unresolved_crashes'))} />
              </View>
              <View style={styles.metricRow}>
                <Metric label="Traffic violations" value={textValue(field(summary, 'traffic_violations_detected'))} />
                <Metric label="Fines pending" value={`${textValue(field(summary, 'fines_pending'))} · ${displayMoney(field(summary, 'fines_pending_amount'))}`} />
                {field(summary, 'cameras_online') !== undefined
                  ? <Metric label="Cameras online" value={textValue(field(summary, 'cameras_online'))} />
                  : <Metric label="Collected" tone="good" value={displayMoney(field(summary, 'fines_collected_amount'))} />}
              </View>
              {field(summary, 'crashes_today') !== undefined ? (
                <Text style={styles.caption}>
                  {textValue(field(summary, 'crashes_today'))} crashes today · {textValue(field(summary, 'resolved_today'))} resolved today · {textValue(field(summary, 'violations_today'))} violations today
                </Text>
              ) : null}
              <View style={styles.inlineButtons}>
                <Button compact onPress={() => changeTab('Live Camera Feeds')} title="Live cameras" />
                <Button compact onPress={() => changeTab('Crash Incident Radar')} secondary title="Crash radar" />
              </View>
              <Card>
                <Text style={styles.cardTitle}>Latest crash frame</Text>
                {typeof latestFrame === 'string'
                  ? <ProtectedImage api={api} path={latestFrame} />
                  : <Text style={styles.caption}>No crash frame is available yet.</Text>}
              </Card>
              {listField(summary, 'helmet_violations_by_day').length ? (
                <Card>
                  <Text style={styles.cardTitle}>Helmet violations per day</Text>
                  <Text style={styles.caption}>Last {listField(summary, 'helmet_violations_by_day').length} days (IST)</Text>
                  {renderBars(listField(summary, 'helmet_violations_by_day').map((day) => {
                    const item = asRecord(day);
                    const [, month, date] = String(field(item, 'date') ?? '').split('-').map(Number);
                    const count = Number(field(item, 'count') ?? 0);
                    return { label: month ? `${date} ${MONTHS[month - 1]}` : textValue(field(item, 'date')), value: count, text: String(count) };
                  }))}
                </Card>
              ) : null}
              <Card>
                <Text style={styles.cardTitle}>Violations by type</Text>
                {byType.length === 0
                  ? <Text style={styles.caption}>No violations recorded.</Text>
                  : byType.map(([kind, count]) => (
                    <View key={kind} style={[styles.dataLine, styles.dataLineRow]}>
                      <Text style={[styles.dataValue, styles.shrink]}>{kind}</Text>
                      <Text style={styles.dataStrong}>{textValue(count)}</Text>
                    </View>
                  ))}
              </Card>
              <SectionLabel>Recent crashes</SectionLabel>
              {renderGenericList(summary, ['recent_crashes'], 'No crashes have been recorded.')}
            </>
          ) : <Empty text="No summary data returned." />}
        </View>
      );
    }
    return <Empty text="Select an authority section." />;
  };

  const sectionReady = loadedTab === tab;
  const activeAlert = asRecord(activeAuthorityAlert);
  return (
    <View style={styles.safeArea}>
      {/* Dark header: light status-bar icons. The header colour extends under the status bar. */}
      <StatusBar style="light" />
      <View style={[styles.header, { paddingTop: insets.top + 10, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
        <View style={styles.shrink}>
          <Text style={styles.brandMarkSmall}>AGHAT SETHU</Text>
          <Text numberOfLines={1} style={styles.headerTitle}>{labelForRole(role)} portal</Text>
          <Text numberOfLines={1} style={styles.headerSubtitle}>{savedName || account.email}</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityLabel="All sections"
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => setMenuOpen(true)}
            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
          >
            <Text style={styles.headerButtonText}>☰  Menu</Text>
          </Pressable>
        </View>
      </View>
      {/* flexGrow:0 — a horizontal ScrollView otherwise grows like the page and squeezes it. */}
      <View style={styles.tabBarWrap}>
        <ScrollView
          contentContainerStyle={[styles.tabBar, { paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }]}
          horizontal
          ref={tabScrollRef}
          showsHorizontalScrollIndicator={false}
          style={styles.tabScroll}
        >
          {tabs.map((item) => (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === item }}
              key={item}
              onLayout={(event) => { tabPositions.current[item] = event.nativeEvent.layout.x; }}
              onPress={() => changeTab(item)}
              style={[styles.tab, tab === item && styles.tabActive]}
            >
              <Text numberOfLines={1} style={[styles.tabText, tab === item && styles.tabTextActive]}>{item}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView
          contentContainerStyle={[
            styles.pageContent,
            { paddingBottom: insets.bottom + 32, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 },
          ]}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          ref={scrollRef}
          refreshControl={<RefreshControl colors={[colors.primary]} progressBackgroundColor={colors.surface} onRefresh={() => void pullToRefresh()} refreshing={refreshing} />}
          style={styles.flex}
        >
          {banner ? <Card><Text style={styles.errorText}>{banner}</Text></Card> : null}
          {globalError ? <Card><Text style={styles.errorText}>{globalError}</Text></Card> : null}
          {error ? (
            <Card>
              <Text style={styles.errorText}>{error}</Text>
              <Button onPress={() => void refresh()} secondary title="Try again" />
            </Card>
          ) : null}
          {!sectionReady && !error ? (
            <View style={styles.loadingBlock}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.caption}>Loading {tab}…</Text>
            </View>
          ) : sectionReady ? (isCitizen ? renderCitizen() : renderAuthority()) : null}
          {busy && sectionReady ? <ActivityIndicator color={colors.primary} style={styles.inlineSpinner} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        animationType="fade"
        navigationBarTranslucent
        onRequestClose={() => setMenuOpen(false)}
        statusBarTranslucent
        transparent
        visible={menuOpen}
      >
        <Pressable accessibilityLabel="Close menu" onPress={() => setMenuOpen(false)} style={styles.menuShade}>
          <Pressable
            onPress={() => undefined}
            style={[styles.menuSheet, { paddingBottom: insets.bottom + 16, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}
          >
            <View style={styles.menuHandle} />
            <Text style={styles.cardTitle}>Sections</Text>
            <ScrollView style={styles.menuList}>
              {tabs.map((item) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: tab === item }}
                  key={item}
                  onPress={() => changeTab(item)}
                  style={({ pressed }) => [styles.menuItem, tab === item && styles.menuItemActive, pressed && styles.menuItemPressed]}
                >
                  <Text style={[styles.menuItemText, tab === item && styles.menuItemTextActive]}>{item}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Button
              onPress={() => {
                setMenuOpen(false);
                void onLogout();
              }}
              secondary
              title="Sign out"
            />
          </Pressable>
        </Pressable>
      </Modal>

      <AlarmPopup
        badge={isCitizen ? 'POSSIBLE CRASH' : `CRASH DETECTED${authorityAlerts.length > 1 ? ` · ${authorityAlerts.length} ALERTS` : ''}`}
        details={isCitizen ? (
          <>
            <Text style={styles.alarmDetail}>Incident {confirmationIncidentId}</Text>
            {confirmationIncident ? (
              <>
                <Text style={styles.alarmDetail}>Junction: {textValue(field(confirmationIncident, 'junction_id'))}</Text>
                <Text style={styles.alarmDetail}>Severity: {severityLabel(field(confirmationIncident, 'severity'))}</Text>
                <Text style={styles.alarmDetail}>Time: {displayDate(field(confirmationIncident, 'occurred_at', 'time'))}</Text>
              </>
            ) : null}
            {renderLocationShare(true)}
            {confirmationMessage ? <Text style={styles.alarmError}>{confirmationMessage}</Text> : null}
            {alarmMuted ? <Text style={styles.alarmDetail}>Siren silenced. Please still answer below.</Text> : null}
          </>
        ) : (
          <>
            <Text style={styles.alarmDetail}>Incident {textValue(field(activeAlert, 'incident_id', 'id'))}</Text>
            <Text style={styles.alarmDetail}>Severity: {severityLabel(field(activeAlert, 'severity'))}</Text>
            {mapIncident(activeAlert).location ? (
              <Text style={styles.alarmDetail}>
                Location: {mapIncident(activeAlert).location!.latitude.toFixed(5)}, {mapIncident(activeAlert).location!.longitude.toFixed(5)}
              </Text>
            ) : null}
            <Text style={styles.alarmDetail}>Time: {displayDate(field(activeAlert, 'occurred_at', 'time'))}</Text>
            <Text style={styles.alarmDetail}>Vehicles: {formatCell(field(activeAlert, 'involved_vehicles'))}</Text>
            {alarmMuted ? <Text style={styles.alarmDetail}>Siren silenced. Acknowledge to dismiss this alert.</Text> : null}
          </>
        )}
        message={isCitizen
          ? 'A crash involving one of your registered vehicles was reported. If you need help, responders will see your live location. This alarm keeps sounding until you answer.'
          : 'A new crash was reported. The alarm keeps sounding until you acknowledge it.'}
        title={isCitizen ? 'Are you in an accident?' : `Crash at ${textValue(field(activeAlert, 'junction_id', 'junction'))}`}
        visible={alarmActive}
      >
        {isCitizen ? (
          <>
            <Button danger disabled={busy} onPress={() => void answerIncident(true)} style={styles.alarmButton} title="Yes, I need help" />
            <HoldButton disabled={busy} inverted onConfirm={() => void answerIncident(false)} style={styles.alarmButton} title="Hold: I'm safe — false alarm" />
            <Button inverted onPress={callEmergency} secondary style={styles.alarmButton} title={`Call ${EMERGENCY_NUMBER} (silences siren)`} />
          </>
        ) : (
          <>
            <Button danger onPress={() => acknowledgeAuthorityAlert('map')} style={styles.alarmButton} title="Acknowledge and open map" />
            <Button inverted onPress={() => acknowledgeAuthorityAlert('evidence')} style={styles.alarmButton} title="Acknowledge and open evidence" />
            <Button inverted onPress={() => acknowledgeAuthorityAlert(false)} secondary style={styles.alarmButton} title="Acknowledge" />
            {!alarmMuted ? <Button inverted onPress={() => setAlarmMuted(true)} secondary style={styles.alarmButton} title="Silence siren" /> : null}
          </>
        )}
      </AlarmPopup>
    </View>
  );
}

/** Status of the background crash monitor, with one-tap fixes for what Android needs from the user. */
function BackgroundAlarmCard() {
  const [status, setStatus] = useState<CrashMonitorStatus | null>(() => CrashMonitor.status());
  useEffect(() => {
    if (!crashMonitorAvailable) return undefined;
    const read = () => setStatus(CrashMonitor.status());
    const timer = setInterval(read, 3000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') read(); });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  if (!crashMonitorAvailable || !status) return null;
  const ready = status.running && status.notificationsAllowed && status.fullScreenAllowed && status.batteryUnrestricted;
  return (
    <Card>
      <View style={styles.cardHeading}>
        <Text style={[styles.cardTitle, styles.shrink]}>Crash alarm when the app is closed</Text>
        <Tag tone={ready ? 'good' : status.running ? 'warning' : 'bad'}>{ready ? 'ready' : status.running ? 'needs setup' : 'off'}</Tag>
      </View>
      <Text style={styles.bodyText}>
        AGHAT SETHU keeps watching for crashes in the background and sounds a full-screen alarm, even on the lock screen.
      </Text>
      {!status.running ? <Text style={styles.errorText}>Background monitoring is not running. Sign out and sign in again to restart it.</Text> : null}
      {!status.notificationsAllowed ? (
        <Button compact onPress={() => void requestNotificationPermission().then(() => setStatus(CrashMonitor.status()))} title="Allow notifications" />
      ) : null}
      {!status.fullScreenAllowed ? (
        <Button compact onPress={() => CrashMonitor.openFullScreenSettings()} title="Allow full-screen alarms" />
      ) : null}
      {!status.batteryUnrestricted ? (
        <Button compact onPress={() => CrashMonitor.requestBatteryExemption()} secondary title="Don't pause the alarm to save battery" />
      ) : null}
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <View style={styles.metric}>
      <Text adjustsFontSizeToFit minimumFontScale={0.6} numberOfLines={1} style={[styles.metricValue, tone === 'good' && styles.metricGood, tone === 'bad' && styles.metricBad]}>{value}</Text>
      <Text numberOfLines={2} style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return <Card style={styles.emptyCard}><Text style={styles.emptyTitle}>Nothing to show</Text><Text style={styles.bodyText}>{text}</Text></Card>;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <Root />
      </SettingsProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  // Subscribing to the settings re-renders the whole tree when the theme changes, so every style updates.
  useSettings();
  // Lazy state (not useMemo) so the client — and the session token it holds — is never recreated.
  const [api] = useState(() => new ApiClient(configuredApiUrl));
  const [account, setAccount] = useState<Account | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    // An expired or revoked token sends the user back to sign-in instead of failing every screen.
    api.onUnauthorized = () => {
      CrashMonitor.stop();
      setAccount((current) => {
        if (current) setNotice('Your session has expired. Please sign in again.');
        return null;
      });
    };
    return () => { api.onUnauthorized = undefined; };
  }, [api]);

  useEffect(() => {
    let active = true;
    void api.restoreSession()
      .then((restored) => { if (active && restored) setAccount(restored); })
      .catch((reason: unknown) => {
        if (active) setNotice(reason instanceof Error ? `Could not restore your session: ${reason.message}` : 'Could not restore your session.');
      })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [api]);

  const logout = async () => {
    CrashMonitor.stop();
    void googleSignOut();
    try {
      await api.logout();
    } catch {
      // The local session is cleared even if the server cannot be reached.
    } finally {
      setAccount(null);
    }
  };

  if (checkingSession) {
    return (
      <View style={styles.loading}>
        <StatusBar style={pageStatusBarStyle()} />
        <Text style={styles.brandMark}>AGHAT SETHU</Text>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={styles.caption}>Checking secure session…</Text>
      </View>
    );
  }
  return account ? (
    <Portal account={account} api={api} onLogout={logout} />
  ) : (
    <AuthScreen
      api={api}
      notice={notice}
      onLogin={(next) => { setNotice(''); setAccount(next); }}
    />
  );
}

// One style sheet per palette (light / dark); `styles` reads from the active one.
const styles = themedStyles((colors: Palette) => StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  safeArea: { flex: 1, backgroundColor: colors.page },
  loading: { alignItems: 'center', backgroundColor: colors.page, flex: 1, gap: 14, justifyContent: 'center', padding: 24 },
  statusBarScrim: { backgroundColor: colors.page, left: 0, position: 'absolute', right: 0, top: 0 },
  loadingBlock: { alignItems: 'center', gap: 8, paddingVertical: 48 },
  inlineSpinner: { marginVertical: 8 },

  // Bars (revenue per month, helmet violations per day) and tracking routes
  barRow: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingVertical: 4 },
  barLabel: { color: colors.textBody, fontSize: 12, fontWeight: '700', width: 52 },
  barTrack: { backgroundColor: colors.track, borderRadius: 4, flex: 1, height: 12, overflow: 'hidden' },
  barFill: { backgroundColor: colors.primary, borderRadius: 4, height: 12 },
  barValue: { color: colors.text, fontSize: 12, fontWeight: '700', minWidth: 64, textAlign: 'right' },
  routeStep: { alignItems: 'center', borderTopColor: colors.border, borderTopWidth: 1, flexDirection: 'row', gap: 10, paddingVertical: 8 },
  routeIndex: { backgroundColor: colors.primarySoft, borderRadius: 12, color: colors.link, fontWeight: '900', height: 24, lineHeight: 24, textAlign: 'center', width: 24 },

  // Auth
  authPage: { alignItems: 'center', flexGrow: 1, gap: 16, justifyContent: 'center' },
  authCard: { maxWidth: 560, width: '100%' },
  brandBlock: { maxWidth: 560, width: '100%' },
  brandMark: { color: colors.link, fontSize: 13, fontWeight: '900', letterSpacing: 3 },
  heroTitle: { color: colors.text, fontSize: 28, fontWeight: '900', lineHeight: 35, marginTop: 10 },
  heroBody: { color: colors.textBody, fontSize: 14, lineHeight: 21, marginTop: 8 },
  infoLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 560 },
  infoLink: { color: colors.link, fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 8 },
  infoCard: { maxHeight: '80%', maxWidth: 520, width: '100%' },
  modalScroll: { flexGrow: 0 },
  orDivider: { color: colors.textMuted, fontSize: 12, fontWeight: '700', marginTop: 12, textAlign: 'center', textTransform: 'uppercase' },
  plateRow: { marginTop: 10 },

  // Portal chrome
  header: { alignItems: 'center', backgroundColor: colors.header, flexDirection: 'row', gap: 12, justifyContent: 'space-between', paddingBottom: 12 },
  brandMarkSmall: { color: '#84ADFF', fontSize: 10, fontWeight: '900', letterSpacing: 2.5 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '800', marginTop: 2 },
  headerSubtitle: { color: '#98A2B3', fontSize: 12, marginTop: 1 },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerButton: { borderColor: '#344054', borderRadius: 10, borderWidth: 1, justifyContent: 'center', minHeight: 40, paddingHorizontal: 12 },
  headerButtonPressed: { backgroundColor: '#1D2939' },
  headerButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  tabBarWrap: { backgroundColor: colors.surface, borderBottomColor: colors.border, borderBottomWidth: 1 },
  tabScroll: { flexGrow: 0 },
  tabBar: { alignItems: 'center', gap: 8, paddingVertical: 10 },
  tab: { borderColor: colors.borderStrong, borderRadius: 999, borderWidth: 1, justifyContent: 'center', minHeight: 36, paddingHorizontal: 14 },
  tabActive: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  tabText: { color: colors.textBody, fontSize: 13, fontWeight: '700' },
  tabTextActive: { color: colors.primaryDark },
  pageContent: { alignSelf: 'center', gap: 14, maxWidth: 960, paddingTop: 16, width: '100%' },

  // Menu sheet
  menuShade: { backgroundColor: 'rgba(16,24,40,0.55)', flex: 1, justifyContent: 'flex-end' },
  menuSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%', paddingTop: 10 },
  menuHandle: { alignSelf: 'center', backgroundColor: colors.borderStrong, borderRadius: 3, height: 5, marginBottom: 12, width: 44 },
  menuList: { flexGrow: 0, marginTop: 8 },
  menuItem: { borderRadius: 10, justifyContent: 'center', minHeight: 46, paddingHorizontal: 12 },
  menuItemActive: { backgroundColor: colors.primarySoft },
  menuItemPressed: { backgroundColor: colors.surfaceMuted },
  menuItemText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  menuItemTextActive: { color: colors.primaryDark, fontWeight: '800' },

  // Content
  stack: { gap: 12 },
  screenTitle: { marginBottom: 2 },
  screenTitleText: { color: colors.text, fontSize: 22, fontWeight: '900' },
  sectionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 0.6, marginTop: 6, textTransform: 'uppercase' },
  caption: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 16, borderWidth: 1, padding: 16 },
  pressedCard: { opacity: 0.85 },
  cardHeading: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  bodyText: { color: colors.textBody, fontSize: 14, lineHeight: 21, marginTop: 6 },
  label: { color: colors.textStrong, fontSize: 13, fontWeight: '700', marginBottom: 6 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 5 },
  inputGroup: { marginTop: 12 },
  inputRow: { alignItems: 'center', flexDirection: 'row' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputFlex: { flex: 1 },
  revealButton: { justifyContent: 'center', marginLeft: 8, minHeight: 48, paddingHorizontal: 8 },
  revealText: { color: colors.link, fontSize: 13, fontWeight: '800' },
  button: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: 12,
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  holdButton: { backgroundColor: colors.surface, borderColor: colors.borderStrong, borderWidth: 1, overflow: 'hidden' },
  holdFill: { backgroundColor: colors.successSoft, bottom: 0, left: 0, position: 'absolute', top: 0 },
  holdHint: { color: colors.textMuted, fontSize: 12, marginTop: 4, textAlign: 'center' },
  holdHintInverted: { color: '#FECDCA' },
  buttonCompact: { flexGrow: 1, minHeight: 42, paddingHorizontal: 12 },
  buttonSecondary: { backgroundColor: colors.surface, borderColor: colors.borderStrong, borderWidth: 1 },
  buttonDanger: { backgroundColor: '#D92D20' },
  buttonInverted: { backgroundColor: '#FFFFFF', borderColor: '#FFFFFF', borderWidth: 1 },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', textAlign: 'center' },
  buttonTextSecondary: { color: colors.textStrong },
  buttonTextInverted: { color: '#912018' },
  tag: { alignSelf: 'flex-start', backgroundColor: colors.chip, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  tagGood: { backgroundColor: colors.successSoft },
  tagWarning: { backgroundColor: colors.warningSoft },
  tagBad: { backgroundColor: colors.dangerSoft },
  tagText: { color: colors.textStrong, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  tagTextGood: { color: colors.success },
  tagTextWarning: { color: colors.warning },
  tagTextBad: { color: colors.danger },
  noticeText: { backgroundColor: colors.primarySoft, borderRadius: 10, color: colors.link, fontSize: 13, lineHeight: 19, marginTop: 10, padding: 12 },
  noticeTextPlain: { color: colors.primaryDark, fontSize: 14, lineHeight: 20 },
  errorText: { color: colors.danger, fontSize: 14, lineHeight: 20, marginTop: 6 },
  successText: { color: colors.success, fontSize: 14, lineHeight: 20, marginTop: 6 },
  dataLine: { borderBottomColor: colors.divider, borderBottomWidth: 1, gap: 2, paddingVertical: 8 },
  dataLineRow: { alignItems: 'center', flexDirection: 'row', gap: 12, justifyContent: 'space-between' },
  dataLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'capitalize' },
  dataValue: { color: colors.textStrong, fontSize: 14, lineHeight: 20 },
  dataStrong: { color: colors.text, fontSize: 15, fontWeight: '800' },
  emptyCard: { backgroundColor: colors.surfaceMuted, borderStyle: 'dashed' },
  emptyTitle: { color: colors.textStrong, fontSize: 15, fontWeight: '800' },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 14, borderWidth: 1, flexBasis: 140, flexGrow: 1, padding: 14 },
  metricValue: { color: colors.primaryDark, fontSize: 22, fontWeight: '900' },
  metricGood: { color: colors.success },
  metricBad: { color: colors.danger },
  metricLabel: { color: colors.textMuted, fontSize: 12, lineHeight: 16, marginTop: 4 },
  inlineButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  methodButton: { borderColor: colors.borderStrong, borderRadius: 999, borderWidth: 1, justifyContent: 'center', minHeight: 38, paddingHorizontal: 14 },
  methodButtonActive: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  methodText: { color: colors.textBody, fontSize: 13, fontWeight: '600' },
  methodTextActive: { color: colors.primaryDark, fontWeight: '800' },
  plateChip: { backgroundColor: '#FFFFFF', borderColor: '#101828', borderRadius: 8, borderWidth: 2, justifyContent: 'center', minHeight: 40, paddingHorizontal: 12 },
  plateChipText: { color: '#101828', fontSize: 15, fontWeight: '900', letterSpacing: 1 },
  mediaBlock: { gap: 12, marginTop: 12 },
  evidenceImage: { aspectRatio: 4 / 3, backgroundColor: colors.chip, borderRadius: 10, marginTop: 8, width: '100%' },
  mediaMissing: { alignItems: 'center', backgroundColor: colors.surfaceMuted, borderColor: colors.border, borderRadius: 10, borderStyle: 'dashed', borderWidth: 1, marginTop: 8, padding: 16 },
  mediaMissingText: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  video: { aspectRatio: 16 / 9, backgroundColor: '#000000', borderRadius: 10, marginTop: 8, width: '100%' },

  // Live cameras (original)
  cameraCard: { backgroundColor: '#101828' },
  cameraTitle: { color: '#FFFFFF' },
  cameraFrame: { backgroundColor: '#000000', height: 210, marginTop: 10, width: '100%' },
  cameraEmpty: { alignItems: 'center', backgroundColor: '#1D2939', height: 150, justifyContent: 'center', marginTop: 10 },
  cameraEmptyText: { color: '#D0D5DD', fontSize: 12 },

  // Modals and alarm
  modalShade: { alignItems: 'center', backgroundColor: 'rgba(16,24,40,0.75)', flex: 1, justifyContent: 'center', padding: 20 },
  alarmButton: { marginTop: 0, minHeight: 56 },
  alarmDetail: { color: '#FFFFFF', fontSize: 14, lineHeight: 21 },
  alarmError: { color: '#FECDCA', fontSize: 14, fontWeight: '700', lineHeight: 20, marginTop: 6 },
}));
