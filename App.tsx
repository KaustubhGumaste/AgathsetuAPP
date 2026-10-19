import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as Notifications from 'expo-notifications';
import { VideoView, useVideoPlayer } from 'expo-video';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';
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
  roleFromAccount,
  textValue,
} from './src/api';

type Tab =
  | 'Dashboard'
  | 'My Vehicles'
  | 'My Violations'
  | 'Pay Fines'
  | 'Payment History'
  | 'Notifications'
  | 'Profile Settings'
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
  | 'Vehicle Registry & Search'
  | 'Vehicle Profile'
  | 'Multi-Junction Tracking'
  | 'Violation Detail';

type LiveEvent = Record<string, unknown>;
type PaymentMethod = 'upi' | 'card' | 'netbanking';

const citizenTabs: Tab[] = [
  'Dashboard',
  'My Vehicles',
  'My Violations',
  'Pay Fines',
  'Payment History',
  'Notifications',
  'Profile Settings',
  'Crash Incident Report',
];

const authorityTabs: Tab[] = [
  'Overview',
  'Live Camera Feeds',
  'Junction Overview',
  'Routine Violations',
  'Fines & Revenue',
  'Pending Verification',
  'Crash Incident Radar',
  'Evidence Records',
  'Incident Evidence',
  'Vehicle Registry & Search',
  'Vehicle Profile',
  'Multi-Junction Tracking',
  'Violation Detail',
];

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

function field(record: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return undefined;
}

function recordId(record: Record<string, unknown>) {
  return textValue(field(record, 'id', 'fine_id', 'incident_id', 'job_id', 'reference'));
}

function yearInIST(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-IN', { year: 'numeric', timeZone: 'Asia/Kolkata' }).format(date);
}

function labelForRole(role: Role) {
  return role === 'citizen' ? 'Citizen' : role === 'admin' ? 'Administrator' : 'Authority';
}

function routeForTab(tab: Tab, selectedId?: string) {
  const id = encodeURIComponent(selectedId ?? '');
  switch (tab) {
    case 'Dashboard':
      return '/api/citizen/fines';
    case 'My Vehicles':
    case 'Profile Settings':
      return '/api/auth/me';
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
    case 'Fines & Revenue':
      return '/api/authority/fines';
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
}: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary && styles.buttonSecondary,
        danger && styles.buttonDanger,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{title}</Text>
    </Pressable>
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
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#98A2B3"
        secureTextEntry={secureTextEntry}
        style={styles.input}
        value={value}
      />
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
      <Text style={styles.screenTitleText}>{title}</Text>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
  );
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
  apiUrl,
  onApiUrlChange,
  onLogin,
}: {
  api: ApiClient;
  apiUrl: string;
  onApiUrlChange: (value: string) => void;
  onLogin: (account: Account) => void;
}) {
  const [portal, setPortal] = useState<'citizen' | 'authority'>('citizen');
  const [mode, setMode] = useState<'home' | 'login' | 'register'>('home');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [apiError, setApiError] = useState('');

  const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

  const enterPortal = (value: 'citizen' | 'authority') => {
    setPortal(value);
    setMode('login');
    setError('');
    setMessage('');
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    setApiError('');
    try {
      if (mode === 'register') {
        if (values.password !== values.confirmPassword) {
          throw new ApiError('Password and confirmation do not match.');
        }
        if (portal === 'citizen') {
          await api.registerCitizen({
            name: values.name ?? '',
            email: values.email ?? '',
            mobile: values.mobile ?? '',
            password: values.password ?? '',
            vehicle_registration_number: values.vehicle_registration_number ?? '',
          });
          setMessage('Citizen account registered. Sign in to continue.');
        } else {
          await api.registerAuthority({
            name: values.name ?? '',
            email: values.email ?? '',
            badge_number: values.badge_number ?? '',
            jurisdiction: values.jurisdiction ?? '',
            password: values.password ?? '',
          });
          setMessage('Officer account submitted. It is awaiting approval.');
        }
        setMode('login');
        return;
      }
      const account = await api.login(values.email ?? '', values.password ?? '');
      const actualRole = roleFromAccount(account);
      if ((portal === 'citizen') !== (actualRole === 'citizen')) {
        await api.logout();
        throw new ApiError('This account belongs to a different portal. Choose the correct sign-in.');
      }
      if (actualRole !== 'citizen' && String(account.status ?? '').toLowerCase() === 'pending') {
        await api.logout();
        throw new ApiError('Your officer account is awaiting approval.');
      }
      onLogin(account);
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : 'The request failed.';
      setError(text);
      if (reason instanceof ApiError && !api.getBaseUrl()) setApiError(text);
    } finally {
      setBusy(false);
    }
  };

  const renderFields = () => {
    if (mode === 'home') return null;
    const common = (
      <>
        <Input
          autoCapitalize="none"
          keyboardType="email-address"
          label={portal === 'citizen' ? 'Email' : 'Official email'}
          onChangeText={(value) => set('email', value)}
          placeholder="name@example.com"
          value={values.email ?? ''}
        />
        {mode === 'register' && (
          <>
            <Input label="Full name" onChangeText={(value) => set('name', value)} value={values.name ?? ''} />
            {portal === 'citizen' ? (
              <>
                <Input keyboardType="phone-pad" label="Mobile" onChangeText={(value) => set('mobile', value)} value={values.mobile ?? ''} />
                <Input
                  autoCapitalize="characters"
                  label="Vehicle registration number"
                  onChangeText={(value) => set('vehicle_registration_number', value.toUpperCase())}
                  value={values.vehicle_registration_number ?? ''}
                />
              </>
            ) : (
              <>
                <Input label="Badge / service number" onChangeText={(value) => set('badge_number', value)} value={values.badge_number ?? ''} />
                <Input label="Jurisdiction / unit" onChangeText={(value) => set('jurisdiction', value)} value={values.jurisdiction ?? ''} />
              </>
            )}
          </>
        )}
        <Input label="Password" onChangeText={(value) => set('password', value)} secureTextEntry value={values.password ?? ''} />
        {mode === 'register' && (
          <Input label="Confirm password" onChangeText={(value) => set('confirmPassword', value)} secureTextEntry value={values.confirmPassword ?? ''} />
        )}
      </>
    );

    return (
      <Card>
        <Text style={styles.cardTitle}>{mode === 'login' ? `${portal === 'citizen' ? 'Citizen' : 'Authority'} sign in` : `${portal === 'citizen' ? 'Citizen' : 'Authority'} registration`}</Text>
        {mode === 'login' && portal === 'authority' && (
          <Text style={styles.noticeText}>For authorised traffic police and control-room officers only. Access is logged.</Text>
        )}
        {common}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {message ? <Text style={styles.successText}>{message}</Text> : null}
        <Button disabled={busy || !apiUrl.trim()} onPress={submit} title={busy ? 'Connecting…' : mode === 'login' ? 'Sign in' : 'Create account'} />
        <Button onPress={() => setMode(mode === 'login' ? 'register' : 'login')} secondary title={mode === 'login' ? 'Create an account' : 'Back to sign in'} />
        <Button onPress={() => { setMode('home'); setError(''); setMessage(''); }} secondary title="Back to portal selection" />
      </Card>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.authPage} keyboardShouldPersistTaps="handled">
        <View style={styles.brandBlock}>
          <Text style={styles.brandMark}>AGHAT SETHU</Text>
          <Text style={styles.heroTitle}>Safer roads through connected evidence.</Text>
          <Text style={styles.heroBody}>Accident detection, vehicle identification and multi-junction investigation.</Text>
        </View>
        <Card>
          <Text style={styles.cardTitle}>FastAPI server</Text>
          <Text style={styles.caption}>Enter the reachable API origin (without `/api`). It is kept only in this app session.</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={(value) => { onApiUrlChange(value); api.setBaseUrl(value); setApiError(''); }}
            placeholder="https://api.example.com"
            placeholderTextColor="#98A2B3"
            style={styles.input}
            value={apiUrl}
          />
          {apiError ? <Text style={styles.errorText}>{apiError}</Text> : null}
        </Card>
        {mode === 'home' ? (
          <Card>
            <Text style={styles.cardTitle}>Choose your portal</Text>
            <Text style={styles.caption}>Your signed-in account is routed to its own role-protected portal.</Text>
            <Button onPress={() => enterPortal('citizen')} title="Citizen Login" />
            <Button onPress={() => enterPortal('authority')} secondary title="Authority Login" />
            <Text style={styles.caption}>Authority and admin accounts require approval. Demo passwords are not embedded in the app.</Text>
          </Card>
        ) : renderFields()}
        <Text style={styles.authFooter}>Privacy Policy  ·  Terms of Use  ·  Accessibility  ·  Help & Contact</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function ProtectedImage({ api, path }: { api: ApiClient; path: string }) {
  const [failed, setFailed] = useState(false);
  const media = mediaSource(api, path);
  if (failed || !media) return <Text style={styles.caption}>Evidence image could not be loaded from the configured API.</Text>;
  return (
    <Image
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

function ProtectedVideo({ api, path }: { api: ApiClient; path: string }) {
  const media = mediaSource(api, path);
  const source = useMemo(() => ({
    uri: media?.uri ?? api.url('/api/media-unavailable'),
    headers: media?.sameOrigin && api.currentToken ? { Authorization: `Bearer ${api.currentToken}` } : undefined,
  }), [api, media?.sameOrigin, media?.uri]);
  const player = useVideoPlayer(source);
  if (!media) return <Text style={styles.caption}>Video URL is not valid for the configured API.</Text>;
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
  const record = asRecord(value);
  const entries = Object.entries(record).filter(([key]) => !/base64|raw_frame/i.test(key));
  const images = entries.filter(([key, item]) => /image|snapshot|evidence|photo|frame/i.test(key) && typeof item === 'string');
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
    <Pressable disabled={!onSelect} onPress={onSelect}>
      <Card>
        <View style={styles.cardHeading}>
          <Text style={styles.cardTitle}>
            {textValue(field(record, 'title', 'plate_number', 'challan_number', 'reference', 'id', 'incident_id', 'vehicle_registration_number', 'junction_id') ?? 'Record')}
          </Text>
          {status ? <Tag tone={statusTone}>{status}</Tag> : null}
        </View>
        {entries.slice(0, 14).map(([key, item]) => {
          if (images.some(([imageKey]) => imageKey === key)) return null;
          const money = /amount|revenue|total_unpaid/i.test(key);
          const date = /time|date|created|paid_at|timestamp|detected/i.test(key);
          return (
            <View key={key} style={styles.dataLine}>
              <Text style={styles.dataLabel}>{key.replaceAll('_', ' ')}</Text>
              <Text selectable style={styles.dataValue}>
                {money ? displayMoney(item) : date ? displayDate(item) : textValue(item)}
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
      {result ? <DataCard api={api} value={result} /> : <ActivityIndicator color="#175CD3" />}
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
      <View style={styles.inlineButtons}>
        <Button onPress={() => setEvidenceVisible((current) => !current)} secondary title="Evidence" />
        {!paid && (
          <Button onPress={() => void onPayment(id, method)} title={`Pay ${displayMoney(field(record, 'amount', 'fine_amount'))}`} />
        )}
      </View>
      {!paid && (
        <View style={styles.methodRow}>
          {(['upi', 'card', 'netbanking'] as PaymentMethod[]).map((option) => (
            <Pressable
              accessibilityRole="button"
              key={option}
              onPress={() => setMethod(option)}
              style={[styles.methodButton, method === option && styles.methodButtonActive]}
            >
              <Text style={[styles.methodText, method === option && styles.methodTextActive]}>{option}</Text>
            </Pressable>
          ))}
        </View>
      )}
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
}: {
  account: Account;
  api: ApiClient;
  onLogout: () => Promise<void>;
}) {
  const role = roleFromAccount(account);
  const isCitizen = role === 'citizen';
  const tabs = isCitizen ? citizenTabs : authorityTabs;
  const [tab, setTab] = useState<Tab>(tabs[0]);
  const [data, setData] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [globalError, setGlobalError] = useState('');
  const [paymentMessage, setPaymentMessage] = useState('');
  const [profileMessage, setProfileMessage] = useState('');
  const [profileName, setProfileName] = useState(account.name ?? '');
  const [profileMobile, setProfileMobile] = useState(account.mobile ?? '');
  const [selectedId, setSelectedId] = useState('');
  const [resolvePassword, setResolvePassword] = useState('');
  const [job, setJob] = useState<Record<string, unknown> | null>(null);
  const [liveEvent, setLiveEvent] = useState<LiveEvent | null>(null);
  const [liveError, setLiveError] = useState('');
  const [frameData, setFrameData] = useState<Record<string, string>>({});
  const lastFrameUpdate = useRef(0);
  const [tracksData, setTracksData] = useState<unknown>(null);
  const [localAlert, setLocalAlert] = useState<LiveEvent | null>(null);
  const [alarmPending, setAlarmPending] = useState(false);
  const [demoHistory, setDemoHistory] = useState<Array<{ id: string; response: string; time: string }>>([]);
  const [demoResponse, setDemoResponse] = useState('');
  const [notificationFilter, setNotificationFilter] = useState<'All' | 'Unread' | 'E-challan' | 'Crash'>('All');
  const [fineFilter, setFineFilter] = useState<'All' | 'Paid' | 'Unpaid'>('All');
  const [finesYear, setFinesYear] = useState(String(new Date().getFullYear()));
  const seenNotificationIds = useRef(new Set<string>());
  const notificationsInitialized = useRef(false);

  const refresh = useCallback(async (target: Tab = tab, id = selectedId) => {
    const path = routeForTab(target, id);
    if (!path) {
      setData(null);
      setError('');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await api.get<unknown>(path);
      setData(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load this section.');
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [api, selectedId, tab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (isCitizen || !api.currentToken || !api.getBaseUrl() || Platform.OS === 'web') return undefined;
    const socketUrl = api.url('/ws/live-cameras').replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    const AuthenticatedSocket = WebSocket as unknown as new (
      url: string,
      protocols: string[],
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const socket = new AuthenticatedSocket(socketUrl, [], {
      headers: { Authorization: `Bearer ${api.currentToken}` },
    });
    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') return;
      try {
        const event = asRecord(JSON.parse(message.data));
        const eventName = String(field(event, 'type', 'event', 'kind') ?? '');
        const junction = String(field(event, 'junction_id', 'junction', 'camera_id') ?? 'unknown');
        const frame = field(event, 'image_base64', 'jpeg_base64', 'frame_base64', 'jpeg');
        if (typeof frame === 'string' && Date.now() - lastFrameUpdate.current >= 250) {
          lastFrameUpdate.current = Date.now();
          setFrameData((current) => ({ ...current, [junction]: frame.replace(/^data:image\/jpeg;base64,/, '') }));
        }
        if (eventName !== 'camera_frame' && eventName !== 'vehicle_boxes') setLiveEvent(event);
        if (eventName === 'crash_alert') {
          setLocalAlert(event);
          void sendLocalNotification('Crash detected', `${junction}: new crash alert received.`)
            .catch((reason: unknown) => setGlobalError(reason instanceof Error ? reason.message : 'Could not show local notification.'));
        }
      } catch {
        setLiveError('The live camera service sent an unreadable message.');
      }
    };
    socket.onerror = () => setLiveError('Live camera connection failed. Check the API/WebSocket address and server availability.');
    socket.onclose = () => setLiveError('Live camera connection closed.');
    return () => socket.close();
  }, [api, isCitizen]);

  useEffect(() => {
    if (!isCitizen || !api.currentToken || !api.getBaseUrl()) return undefined;
    let active = true;
    const checkNotifications = async () => {
      try {
        const response = await api.get<unknown>('/api/citizen/notifications');
        if (!active) return;
        for (const item of asList(response, ['notifications'])) {
          const record = asRecord(item);
          const id = recordId(record);
          if (id === '—') continue;
          if (notificationsInitialized.current && !seenNotificationIds.current.has(id)) {
            const kind = String(field(record, 'kind', 'type') ?? 'Account update');
            await sendLocalNotification(kind, String(field(record, 'message', 'title') ?? 'A new account notification is available.'));
          }
          seenNotificationIds.current.add(id);
        }
        notificationsInitialized.current = true;
      } catch (reason) {
        if (active) setGlobalError(reason instanceof Error ? reason.message : 'Could not refresh notifications.');
      }
    };
    void checkNotifications();
    const timer = setInterval(() => void checkNotifications(), 20000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, isCitizen]);

  useEffect(() => {
    if (!alarmPending) return undefined;
    Vibration.vibrate(700);
    const timer = setInterval(() => Vibration.vibrate(700), 1400);
    return () => {
      clearInterval(timer);
      Vibration.cancel();
    };
  }, [alarmPending]);

  const changeTab = (next: Tab) => {
    setTab(next);
    setError('');
    setPaymentMessage('');
    if (next !== 'Incident Evidence' && next !== 'Crash Incident Report') setSelectedId('');
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
      setPaymentMessage(`Payment response: ${JSON.stringify(receipt)}`);
      await refresh('Pay Fines');
    } catch (reason) {
      setPaymentMessage(reason instanceof Error ? reason.message : 'Payment could not be completed.');
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
      setError('Select an incident and enter your password to resolve it.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/incidents/${encodeURIComponent(selectedId)}/resolve`, { password: resolvePassword });
      setResolvePassword('');
      await refresh('Incident Evidence', selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Incident could not be resolved.');
    } finally {
      setBusy(false);
    }
  };

  const updateProfile = async () => {
    setBusy(true);
    setProfileMessage('');
    try {
      const response = await api.patch<Account>('/api/auth/me', { name: profileName, mobile: profileMobile });
      setProfileName(response.name ?? profileName);
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
      await refresh('Notifications');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Notification update failed.');
    } finally {
      setBusy(false);
    }
  };

  const chooseIncident = (id: string) => {
    setSelectedId(id);
    setTab('Incident Evidence');
    setTracksData(null);
    void refresh('Incident Evidence', id);
    void api.get<unknown>(`/api/incidents/${encodeURIComponent(id)}/tracks`)
      .then(setTracksData)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not load incident tracks.'));
  };

  const renderGenericList = (value: unknown, keys: string[] = []) => {
    const list = asList(value, keys);
    if (list.length === 0) return <Empty text="No records returned by the backend." />;
    return list.map((item, index) => {
      const record = asRecord(item);
      const id = recordId(record);
      return (
        <DataCard
          api={api}
          key={`${id}-${index}`}
          onSelect={!isCitizen && String(field(record, 'id', 'incident_id')) !== 'undefined' ? () => chooseIncident(id) : undefined}
          value={item}
        />
      );
    });
  };

  const renderCitizen = () => {
    if (tab === 'Profile Settings') {
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Profile settings" caption="Changes are saved to your account." />
          <Card>
            <Input label="Full name" onChangeText={setProfileName} value={profileName} />
            <Input keyboardType="phone-pad" label="Mobile" onChangeText={setProfileMobile} value={profileMobile} />
            <Text style={styles.caption}>Email: {textValue(account.email)}</Text>
            {profileMessage ? <Text style={styles.successText}>{profileMessage}</Text> : null}
            <Button disabled={busy} onPress={() => void updateProfile()} title="Save profile" />
          </Card>
        </View>
      );
    }
    if (tab === 'My Vehicles') {
      const accountVehicles = field(asRecord(data), 'vehicles');
      const plate = field(asRecord(data), 'vehicle_registration_number', 'vehicle_plate', 'plate_number');
      return (
        <View style={styles.stack}>
          <ScreenTitle title="My vehicles" caption="Only vehicles returned by your authenticated profile are shown." />
          {Array.isArray(accountVehicles) && accountVehicles.length > 0
            ? renderGenericList(accountVehicles, ['vehicles'])
            : plate
              ? <DataCard api={api} value={{ vehicle_registration_number: plate }} />
              : <Empty text="The documented API contract does not include a citizen vehicle-list endpoint. No vehicle records were returned in your profile." />}
        </View>
      );
    }
    if (tab === 'Payment History') {
      return <View style={styles.stack}><ScreenTitle title="Payment history" caption="Receipts returned by the payment service." />{renderGenericList(data, ['payments'])}</View>;
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
          <ScreenTitle title="Notifications" caption="Citizen alerts from your account." />
          <View style={styles.methodRow}>
            {(['All', 'Unread', 'E-challan', 'Crash'] as const).map((filter) => (
              <Pressable
                accessibilityRole="button"
                key={filter}
                onPress={() => setNotificationFilter(filter)}
                style={[styles.methodButton, notificationFilter === filter && styles.methodButtonActive]}
              >
                <Text style={[styles.methodText, notificationFilter === filter && styles.methodTextActive]}>{filter}</Text>
              </Pressable>
            ))}
          </View>
          <Button onPress={() => void markRead('all')} secondary title="Mark all as read" />
          {list.length === 0 ? <Empty text="No notifications returned by the backend." /> : list.map((item, index) => {
            const record = asRecord(item);
            const id = recordId(record);
            const incidentId = textValue(field(record, 'incident_id', 'reference_id'));
            const kind = String(field(record, 'kind', 'type') ?? '');
            return (
              <DataCard api={api} key={`${id}-${index}`} value={item}>
                <View style={styles.inlineButtons}>
                  <Button onPress={() => void markRead(id)} secondary title="Mark read" />
                  {kind.toLowerCase().includes('crash') && incidentId !== '—' ? (
                    <Button onPress={() => { setSelectedId(incidentId); changeTab('Crash Incident Report'); }} title="Incident report" />
                  ) : null}
                </View>
              </DataCard>
            );
          })}
        </View>
      );
    }
    if (tab === 'Crash Incident Report') {
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Crash incident report" caption="Citizen view excludes camera frames and RFID data." />
          {selectedId ? renderGenericList(data, ['incident']) : <Empty text="Open this report from a crash notification. No citizen incident ID was selected." />}
        </View>
      );
    }
    if (tab === 'Pay Fines' || tab === 'My Violations') {
      const list = asList(data, ['fines', 'violations']);
      return (
        <View style={styles.stack}>
          <ScreenTitle title={tab === 'Pay Fines' ? 'Pay fines' : 'Traffic e-challan history'} caption="Fines and evidence are loaded from your account." />
          {paymentMessage ? <Card><Text style={styles.bodyText}>{paymentMessage}</Text></Card> : null}
          {list.length === 0 ? <Empty text="No fines or violations returned by the backend." /> : list.map((fine, index) => (
            <PaymentFineCard api={api} fine={fine} key={`${recordId(asRecord(fine))}-${index}`} onPayment={payFine} />
          ))}
        </View>
      );
    }
    if (tab === 'Dashboard') {
      const fines = asList(data, ['fines']);
      const statuses = fines.map((fine) => String(field(asRecord(fine), 'status', 'payment_status') ?? '').toLowerCase());
      const knownUnpaid = statuses.filter((status) => status === 'unpaid' || status === 'pending').length;
      const unpaidAmount = fines.reduce<number>((sum, fine) => {
        const record = asRecord(fine);
        const status = String(field(record, 'status', 'payment_status') ?? '').toLowerCase();
        const amount = Number(field(record, 'amount', 'fine_amount'));
        return (status === 'unpaid' || status === 'pending') && Number.isFinite(amount) ? sum + amount : sum;
      }, 0);
      const vehicleRows = field(account, 'vehicles');
      return (
        <View style={styles.stack}>
          <ScreenTitle title={`Welcome back${profileName ? `, ${profileName}` : ''}`} caption="Citizen dashboard · Bengaluru traffic services" />
          <Card>
            <Text style={styles.cardTitle}>Account summary</Text>
            <Text style={styles.bodyText}>Your vehicle and fine information is loaded from the authenticated service.</Text>
            <View style={styles.metricRow}>
              <Metric label="Registered vehicles" value={Array.isArray(vehicleRows) ? String(vehicleRows.length) : '—'} />
              <Metric label="Fines issued" value={String(fines.length)} />
              <Metric label="Unpaid fines" value={statuses.every((status) => status) ? String(knownUnpaid) : '—'} />
            </View>
            <View style={styles.metricRow}>
              <Metric label="Total unpaid" value={statuses.every((status) => status) ? displayMoney(unpaidAmount) : '—'} />
            </View>
          </Card>
          {fines.slice(0, 5).map((fine, index) => <DataCard api={api} key={`${recordId(asRecord(fine))}-${index}`} value={fine} />)}
        </View>
      );
    }
    return <Empty text="Select a citizen section." />;
  };

  const renderCameraGrid = () => {
    const cameras = asList(data, ['cameras', 'junctions', 'items']);
    const knownJunctions = cameras.length ? cameras : ['J01', 'J02', 'J03'];
    return (
      <View style={styles.stack}>
        <ScreenTitle title="Live camera feeds" caption={liveError || 'Live feed frames appear only when received from the authenticated backend WebSocket.'} />
        {knownJunctions.map((camera, index) => {
          const record = asRecord(camera);
          const id = textValue(typeof camera === 'string' ? camera : field(record, 'junction_id', 'id', 'name') ?? `Camera ${index + 1}`);
          const frame = frameData[id];
          return (
            <Card key={id} style={styles.cameraCard}>
              <Text style={styles.cardTitle}>{id}</Text>
              {frame ? (
                <Image source={{ uri: `data:image/jpeg;base64,${frame}` }} style={styles.cameraFrame} resizeMode="contain" />
              ) : (
                <View style={styles.cameraEmpty}><Text style={styles.cameraEmptyText}>No live frame received</Text></View>
              )}
              {typeof camera === 'string' ? null : <Text style={styles.caption}>{JSON.stringify(record)}</Text>}
            </Card>
          );
        })}
        {liveEvent ? <DataCard api={api} value={liveEvent} /> : <Empty text="Waiting for live camera events. The mobile client connects with a bearer-authenticated WebSocket on native builds." />}
      </View>
    );
  };

  const renderAuthority = () => {
    if (tab === 'Live Camera Feeds') return renderCameraGrid();
    if (tab === 'Routine Violations') {
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Routine violations · Level 1" caption="Upload a traffic video to the backend analysis pipeline." />
          <Card>
            <Text style={styles.bodyText}>The backend processes violation detection, plate OCR and fine generation. Results are not fabricated locally.</Text>
            <Button disabled={busy} onPress={() => void pickVideo()} title={busy ? 'Uploading…' : 'Upload traffic video'} />
          </Card>
          {job ? <VideoJob api={api} job={job} /> : <Empty text="No video job submitted in this session." />}
        </View>
      );
    }
    if (tab === 'Incident Evidence') {
      const detail = asRecord(data);
      const incident = selectedId ? asList(data, ['incident']) : [];
      const tracks = field(detail, 'tracks');
      return (
        <View style={styles.stack}>
          <ScreenTitle title="Incident evidence" caption={selectedId ? `Incident ${selectedId}` : 'Select an incident from the radar or records list.'} />
          {selectedId ? (
            <>
              {incident.map((item, index) => <DataCard api={api} key={index} value={item} />)}
              {tracks ? <DataCard api={api} value={{ tracks }} /> : tracksData ? <DataCard api={api} value={tracksData} /> : null}
              <Card>
                <Text style={styles.cardTitle}>Resolve incident</Text>
                <Input label="Re-enter password" onChangeText={setResolvePassword} secureTextEntry value={resolvePassword} />
                <Button danger disabled={busy} onPress={() => void resolveIncident()} title="Resolve incident" />
              </Card>
            </>
          ) : renderGenericList(data, ['incidents'])}
        </View>
      );
    }
    if (tab === 'Vehicle Registry & Search' || tab === 'Vehicle Profile' || tab === 'Multi-Junction Tracking' || tab === 'Violation Detail') {
      return (
        <View style={styles.stack}>
          <ScreenTitle title={tab} caption="Vehicle-intelligence pages are listed in the prompt as demo/static website data." />
          <Empty text="No searchable vehicle registry or tracking API endpoint is specified in the supplied backend contract. This mobile app will not invent or display vehicle records." />
        </View>
      );
    }
    if (tab === 'Crash Incident Radar' || tab === 'Evidence Records' || tab === 'Pending Verification') {
      const list = asList(data, tab === 'Pending Verification' ? ['pending_verifications', 'verifications'] : ['incidents']);
      return (
        <View style={styles.stack}>
          <ScreenTitle title={tab} caption="Select a record to open its authority detail." />
          {list.length === 0 ? <Empty text="No records returned by the backend." /> : list.map((item, index) => {
            const record = asRecord(item);
            const id = recordId(record);
            return (
              <DataCard api={api} key={`${id}-${index}`} onSelect={tab === 'Pending Verification' || id === '—' ? undefined : () => chooseIncident(id)} value={item}>
                {tab === 'Pending Verification' && id !== '—' ? (
                  <ProtectedImage api={api} path={`/api/authority/pending-verifications/${encodeURIComponent(id)}/snapshot`} />
                ) : null}
              </DataCard>
            );
          })}
        </View>
      );
    }
    if (tab === 'Fines & Revenue') {
      const allFines = asList(data, ['fines']);
      const visibleFines = allFines.filter((fine) => {
        const record = asRecord(fine);
        const status = String(field(record, 'status', 'payment_status') ?? '').toLowerCase();
        const year = yearInIST(field(record, 'created_at', 'issued_at', 'timestamp', 'date'));
        const statusMatch = fineFilter === 'All' || (fineFilter === 'Paid' ? status === 'paid' : status === 'unpaid' || status === 'pending');
        const yearMatch = year === undefined || year === finesYear;
        return statusMatch && yearMatch;
      });
      return (
        <View style={styles.stack}>
          <ScreenTitle title={tab} caption="Figures reflect only rows returned by the authority API." />
          <View style={styles.methodRow}>
            {(['All', 'Paid', 'Unpaid'] as const).map((filter) => (
              <Pressable key={filter} onPress={() => setFineFilter(filter)} style={[styles.methodButton, fineFilter === filter && styles.methodButtonActive]}>
                <Text style={[styles.methodText, fineFilter === filter && styles.methodTextActive]}>{filter}</Text>
              </Pressable>
            ))}
          </View>
          <Input label="Year" keyboardType="default" onChangeText={setFinesYear} value={finesYear} />
          <Metric label="Records in current response" value={String(visibleFines.length)} />
          {visibleFines.length ? visibleFines.map((fine, index) => <DataCard api={api} key={`${recordId(asRecord(fine))}-${index}`} value={fine} />) : <Empty text="No fines match this filter in the returned page." />}
        </View>
      );
    }
    if (tab === 'Junction Overview') {
      return <View style={styles.stack}><ScreenTitle title={tab} caption="Values are returned by the authority API." />{renderGenericList(data, ['junctions'])}</View>;
    }
    if (tab === 'Overview') {
      return <View style={styles.stack}><ScreenTitle title="Tactical operations centre" caption="Live summary from the authority service." />{data ? <DataCard api={api} value={data} /> : <Empty text="No summary data returned." />}</View>;
    }
    return <Empty text="Select an authority section." />;
  };

  const triggerLocalDemoAlert = () => {
    const id = `LOCAL-${Date.now()}`;
    setDemoResponse('');
    setDemoHistory((history) => [{ id, response: 'Awaiting user', time: displayDate(new Date().toISOString()) }, ...history]);
    setAlarmPending(true);
  };

  const answerDemoAlert = (response: 'Accident confirmed' | 'False alarm') => {
    setDemoResponse(response);
    setAlarmPending(false);
    setDemoHistory((history) => history.map((item, index) => index === 0 ? { ...item, response } : item));
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.brandMarkSmall}>AGHAT SETHU</Text>
          <Text style={styles.headerTitle}>{labelForRole(role)} portal</Text>
        </View>
        <Button onPress={() => void onLogout()} secondary title="Sign out" />
      </View>
      <ScrollView horizontal contentContainerStyle={styles.tabBar} showsHorizontalScrollIndicator={false}>
        {tabs.map((item) => (
          <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === item }} key={item} onPress={() => changeTab(item)} style={[styles.tab, tab === item && styles.tabActive]}>
            <Text style={[styles.tabText, tab === item && styles.tabTextActive]}>{item}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">
        {globalError ? <Card><Text style={styles.errorText}>{globalError}</Text></Card> : null}
        {error ? <Card><Text style={styles.errorText}>{error}</Text><Button onPress={() => void refresh()} secondary title="Retry" /></Card> : null}
        {paymentMessage && tab !== 'Pay Fines' ? <Card><Text style={styles.bodyText}>{paymentMessage}</Text></Card> : null}
        {busy && <ActivityIndicator color="#175CD3" />}
        {isCitizen ? renderCitizen() : renderAuthority()}
        {isCitizen ? (
          <Card style={styles.alertTestCard}>
            <Text style={styles.cardTitle}>Accident confirmation test</Text>
            <Text style={styles.caption}>Manual local preview only. No IMU, crash event, vehicle lookup, emergency contact or server response is connected by this test.</Text>
            <Button onPress={triggerLocalDemoAlert} title="Test confirmation alarm" />
            {demoResponse ? <Text style={styles.successText}>Last local test: {demoResponse}</Text> : null}
            {demoHistory.map((item) => <Text key={item.id} style={styles.caption}>{item.time} · {item.response}</Text>)}
          </Card>
        ) : null}
      </ScrollView>
      <Modal onRequestClose={() => {}} transparent visible={alarmPending}>
        <View style={styles.modalShade}>
          <Card style={styles.alertCard}>
            <Tag tone="bad">POSSIBLE CRASH</Tag>
            <Text style={styles.modalTitle}>Are you in an accident?</Text>
            <Text style={styles.bodyText}>This local test vibrates until you answer. It does not contact emergency services.</Text>
            <Button danger onPress={() => answerDemoAlert('Accident confirmed')} title="Yes, accident happened" />
            <Button onPress={() => answerDemoAlert('False alarm')} secondary title="No, false alarm — I'm safe" />
          </Card>
        </View>
      </Modal>
      <Modal onRequestClose={() => setLocalAlert(null)} transparent visible={!!localAlert}>
        <View style={styles.modalShade}>
          <Card style={styles.alertCard}>
            <Tag tone="bad">CRASH DETECTED</Tag>
            <Text style={styles.modalTitle}>{textValue(field(asRecord(localAlert), 'junction_id', 'junction', 'camera_id'))}</Text>
            <Text style={styles.bodyText}>{JSON.stringify(localAlert)}</Text>
            <Button onPress={() => setLocalAlert(null)} title="Acknowledge" />
          </Card>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.caption}>{label}</Text>
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return <Card style={styles.emptyCard}><Text style={styles.cardTitle}>Nothing to show</Text><Text style={styles.bodyText}>{text}</Text></Card>;
}

async function sendLocalNotification(title: string, body: string) {
  if (Platform.OS === 'web') return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('incident-alerts', {
      name: 'Incident alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 250, 500],
    });
  }
  const permissions = await Notifications.getPermissionsAsync();
  const status = permissions.status === 'granted'
    ? permissions.status
    : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') throw new Error('Notification permission was not granted.');
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: false },
    trigger: null,
  });
}

export default function App() {
  const [apiUrl, setApiUrl] = useState(process.env.EXPO_PUBLIC_API_URL ?? '');
  const api = useMemo(() => new ApiClient(apiUrl), []);
  api.setBaseUrl(apiUrl);
  const [account, setAccount] = useState<Account | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [restoreError, setRestoreError] = useState('');

  useEffect(() => {
    let active = true;
    void api.restoreSession()
      .then((restored) => { if (active && restored) setAccount(restored); })
      .catch((reason: unknown) => {
        if (active) setRestoreError(reason instanceof Error ? reason.message : 'Could not restore the session.');
      })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [api]);

  const logout = async () => {
    try {
      await api.logout();
    } catch (reason) {
      setRestoreError(reason instanceof Error ? reason.message : 'Sign out failed.');
    } finally {
      setAccount(null);
    }
  };

  if (checkingSession) {
    return <SafeAreaView style={styles.loading}><ActivityIndicator color="#175CD3" /><Text style={styles.caption}>Checking secure session…</Text></SafeAreaView>;
  }
  return account ? (
    <>
      {restoreError ? <Text style={styles.errorText}>{restoreError}</Text> : null}
      <Portal account={account} api={api} onLogout={logout} />
    </>
  ) : (
    <AuthScreen api={api} apiUrl={apiUrl} onApiUrlChange={setApiUrl} onLogin={setAccount} />
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F2F4F7' },
  loading: { alignItems: 'center', backgroundColor: '#F2F4F7', flex: 1, justifyContent: 'center', gap: 12 },
  authPage: { flexGrow: 1, gap: 16, justifyContent: 'center', padding: 20, paddingBottom: 44 },
  brandBlock: { alignSelf: 'center', maxWidth: 680, width: '100%' },
  brandMark: { color: '#175CD3', fontSize: 13, fontWeight: '900', letterSpacing: 3 },
  brandMarkSmall: { color: '#84ADFF', fontSize: 10, fontWeight: '900', letterSpacing: 2.5 },
  heroTitle: { color: '#101828', fontSize: 30, fontWeight: '900', lineHeight: 37, marginTop: 12 },
  heroBody: { color: '#475467', fontSize: 14, lineHeight: 21, marginTop: 8 },
  authFooter: { alignSelf: 'center', color: '#667085', fontSize: 11, marginTop: 6, textAlign: 'center' },
  header: { alignItems: 'center', backgroundColor: '#101828', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '800', marginTop: 3 },
  tabBar: { alignItems: 'center', backgroundColor: '#FFFFFF', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  tab: { borderColor: '#D0D5DD', borderRadius: 999, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 8 },
  tabActive: { backgroundColor: '#EFF6FF', borderColor: '#175CD3' },
  tabText: { color: '#475467', fontSize: 12, fontWeight: '700' },
  tabTextActive: { color: '#1849A9' },
  pageContent: { alignSelf: 'center', gap: 14, maxWidth: 900, padding: 16, paddingBottom: 40, width: '100%' },
  stack: { gap: 12 },
  screenTitle: { marginBottom: 2, marginTop: 6 },
  screenTitleText: { color: '#101828', fontSize: 21, fontWeight: '900' },
  caption: { color: '#667085', fontSize: 12, lineHeight: 18, marginTop: 5 },
  card: { backgroundColor: '#FFFFFF', borderColor: '#E4E7EC', borderRadius: 15, borderWidth: 1, padding: 16 },
  cardHeading: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  cardTitle: { color: '#101828', fontSize: 15, fontWeight: '800' },
  bodyText: { color: '#475467', fontSize: 13, lineHeight: 20, marginTop: 8 },
  label: { color: '#344054', fontSize: 12, fontWeight: '700', marginBottom: 6 },
  input: { backgroundColor: '#FFFFFF', borderColor: '#D0D5DD', borderRadius: 10, borderWidth: 1, color: '#101828', fontSize: 14, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10 },
  button: { alignItems: 'center', backgroundColor: '#175CD3', borderRadius: 10, justifyContent: 'center', marginTop: 10, minHeight: 42, paddingHorizontal: 14, paddingVertical: 10 },
  buttonSecondary: { backgroundColor: '#FFFFFF', borderColor: '#D0D5DD', borderWidth: 1 },
  buttonDanger: { backgroundColor: '#B42318' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', textAlign: 'center' },
  buttonTextSecondary: { color: '#344054' },
  inputGroup: { marginTop: 12 },
  tag: { alignSelf: 'flex-start', backgroundColor: '#F2F4F7', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  tagGood: { backgroundColor: '#ECFDF3' },
  tagWarning: { backgroundColor: '#FFFAEB' },
  tagBad: { backgroundColor: '#FEF3F2' },
  tagText: { color: '#344054', fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  tagTextGood: { color: '#027A48' },
  tagTextWarning: { color: '#B54708' },
  tagTextBad: { color: '#B42318' },
  noticeText: { backgroundColor: '#EFF8FF', borderRadius: 8, color: '#175CD3', fontSize: 12, lineHeight: 18, marginTop: 10, padding: 10 },
  errorText: { color: '#B42318', fontSize: 12, lineHeight: 18, marginTop: 8 },
  successText: { color: '#027A48', fontSize: 12, lineHeight: 18, marginTop: 8 },
  dataLine: { borderBottomColor: '#F2F4F7', borderBottomWidth: 1, gap: 3, paddingVertical: 7 },
  dataLabel: { color: '#667085', fontSize: 10, fontWeight: '700', textTransform: 'capitalize' },
  dataValue: { color: '#344054', fontSize: 12, lineHeight: 17 },
  emptyCard: { backgroundColor: '#FCFCFD' },
  metricRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  metric: { backgroundColor: '#F8FAFC', borderRadius: 10, flex: 1, padding: 12 },
  metricValue: { color: '#1849A9', fontSize: 20, fontWeight: '900' },
  inlineButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  methodRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  methodButton: { borderColor: '#D0D5DD', borderRadius: 8, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 7 },
  methodButtonActive: { backgroundColor: '#EFF6FF', borderColor: '#175CD3' },
  methodText: { color: '#475467', fontSize: 11, textTransform: 'capitalize' },
  methodTextActive: { color: '#1849A9', fontWeight: '800' },
  mediaBlock: { gap: 12, marginTop: 12 },
  evidenceImage: { backgroundColor: '#F2F4F7', borderRadius: 8, height: 200, marginTop: 8, width: '100%' },
  video: { backgroundColor: '#101828', height: 220, marginTop: 8, width: '100%' },
  cameraCard: { backgroundColor: '#101828' },
  cameraFrame: { backgroundColor: '#000000', height: 210, marginTop: 10, width: '100%' },
  cameraEmpty: { alignItems: 'center', backgroundColor: '#1D2939', height: 150, justifyContent: 'center', marginTop: 10 },
  cameraEmptyText: { color: '#D0D5DD', fontSize: 12 },
  alertTestCard: { borderColor: '#FDA29B', borderWidth: 1 },
  modalShade: { alignItems: 'center', backgroundColor: 'rgba(16,24,40,0.75)', flex: 1, justifyContent: 'center', padding: 20 },
  alertCard: { maxWidth: 460, width: '100%' },
  modalTitle: { color: '#101828', fontSize: 22, fontWeight: '900', marginTop: 12 },
});
