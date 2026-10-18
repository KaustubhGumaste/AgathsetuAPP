import React, { useEffect, useState } from 'react';
import {
  Modal,
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

type Role = 'user' | 'admin' | 'superadmin';
type IncidentResponse = 'Accident confirmed' | 'False alarm';
type Incident = {
  id: string;
  time: string;
  location: string;
  response: IncidentResponse | 'Awaiting user';
  trigger: string;
};

type DemoAccount = {
  role: Role;
  email: string;
  password: string;
  label: string;
};

const demoAccounts: DemoAccount[] = [
  { role: 'user', email: 'user@netra.demo', password: 'user123', label: 'User' },
  { role: 'admin', email: 'admin@netra.demo', password: 'admin123', label: 'Admin' },
  { role: 'superadmin', email: 'superadmin@netra.demo', password: 'super123', label: 'Super Admin' },
];

const roleLabels: Record<Role, string> = {
  user: 'User',
  admin: 'Admin',
  superadmin: 'Super Admin',
};

const roleTabs: Record<Role, string[]> = {
  user: ['Home', 'My vehicle', 'Alert history'],
  admin: ['Locations', 'Incidents'],
  superadmin: ['Overview', 'Live cameras', 'Evidence'],
};

function Badge({ children, warning = false }: { children: string; warning?: boolean }) {
  return (
    <View style={[styles.badge, warning ? styles.badgeWarning : styles.badgeGood]}>
      <Text style={[styles.badgeText, warning ? styles.badgeWarningText : styles.badgeGoodText]}>
        {children}
      </Text>
    </View>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
    </View>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function LoginScreen({ onLogin }: { onLogin: (role: Role) => void }) {
  const [selectedRole, setSelectedRole] = useState<Role>('user');
  const [email, setEmail] = useState(demoAccounts[0].email);
  const [password, setPassword] = useState(demoAccounts[0].password);
  const [error, setError] = useState('');

  const chooseRole = (account: DemoAccount) => {
    setSelectedRole(account.role);
    setEmail(account.email);
    setPassword(account.password);
    setError('');
  };

  const signIn = () => {
    const account = demoAccounts.find(
      (candidate) =>
        candidate.role === selectedRole &&
        candidate.email === email.trim().toLowerCase() &&
        candidate.password === password,
    );

    if (!account) {
      setError(`The ${roleLabels[selectedRole]} demo credentials don't match.`);
      return;
    }

    setError('');
    onLogin(account.role);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.loginPage} keyboardShouldPersistTaps="handled">
        <View style={styles.loginCard}>
          <Text style={styles.brand}>NETRA</Text>
          <Text style={styles.loginTitle}>Sign in</Text>
          <Text style={styles.subtitle}>Vehicle incident response prototype</Text>

          <Text style={styles.fieldLabel}>Choose account type</Text>
          <View style={styles.roleChoices}>
            {demoAccounts.map((account) => (
              <Pressable
                accessibilityRole="button"
                key={account.role}
                onPress={() => chooseRole(account)}
                style={[
                  styles.roleChoice,
                  selectedRole === account.role && styles.roleChoiceSelected,
                ]}
              >
                <Text
                  style={[
                    styles.roleChoiceText,
                    selectedRole === account.role && styles.roleChoiceTextSelected,
                  ]}
                >
                  {account.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.fieldLabel}>Email</Text>
          <TextInput
            accessibilityLabel="Email"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="name@example.com"
            style={styles.input}
            value={email}
          />
          <Text style={styles.fieldLabel}>Password</Text>
          <TextInput
            accessibilityLabel="Password"
            onChangeText={setPassword}
            onSubmitEditing={signIn}
            placeholder="Password"
            secureTextEntry
            style={styles.input}
            value={password}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <Pressable accessibilityRole="button" onPress={signIn} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Continue as {roleLabels[selectedRole]}</Text>
          </Pressable>

          <View style={styles.demoNote}>
            <Text style={styles.demoNoteTitle}>Local demo accounts</Text>
            {demoAccounts.map((account) => (
              <Text key={account.role} style={styles.demoCredential}>
                {account.label}: {account.email} / {account.password}
              </Text>
            ))}
            <Text style={styles.demoDisclaimer}>
              Demo-only sign-in. No real authentication or account storage is configured.
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function AppHeader({ role, onLogout }: { role: Role; onLogout: () => void }) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.brandSmall}>NETRA</Text>
        <Text style={styles.headerTitle}>{roleLabels[role]} workspace</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={onLogout} style={styles.logoutButton}>
        <Text style={styles.logoutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

function DemoBanner() {
  return (
    <View style={styles.demoBanner}>
      <Text style={styles.demoBannerTitle}>Standalone demo</Text>
      <Text style={styles.demoBannerText}>
        No live IMU, backend, database, CARLA, GPS, or camera is connected.
      </Text>
    </View>
  );
}

function UserHome({ onTriggerAlert }: { onTriggerAlert: () => void }) {
  return (
    <View style={styles.content}>
      <SectionTitle title="Your safety" hint="This device" />
      <Card>
        <View style={styles.cardHeadingRow}>
          <Text style={styles.cardTitle}>Crash detection</Text>
          <Badge warning>Demo only</Badge>
        </View>
        <Text style={styles.bodyText}>
          A real version would receive a crash event from the vehicle IMU. Use the button below
          to preview the confirmation alarm.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onTriggerAlert}
          style={styles.dangerButton}
        >
          <Text style={styles.primaryButtonText}>Test demo crash alert</Text>
        </Pressable>
      </Card>

      <SectionTitle title="Detection workflow" />
      <Card>
        <WorkflowRow number="1" title="IMU reports a possible impact" detail="Sensor connection not configured" />
        <WorkflowRow number="2" title="Vehicle identification is evaluated" detail="Identification service not connected" />
        <WorkflowRow number="3" title="You confirm or reject the alert" detail="Your response helps flag false alarms" last />
      </Card>
      <Card style={styles.infoCard}>
        <Text style={styles.cardTitle}>No vehicle linked</Text>
        <Text style={styles.bodyText}>
          Vehicle details and emergency contacts will appear here after account and vehicle
          services are integrated.
        </Text>
      </Card>
    </View>
  );
}

function WorkflowRow({
  number,
  title,
  detail,
  last = false,
}: {
  number: string;
  title: string;
  detail: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.workflowRow, last && styles.workflowRowLast]}>
      <View style={styles.stepNumber}>
        <Text style={styles.stepNumberText}>{number}</Text>
      </View>
      <View style={styles.workflowCopy}>
        <Text style={styles.listTitle}>{title}</Text>
        <Text style={styles.mutedText}>{detail}</Text>
      </View>
    </View>
  );
}

function MyVehicle() {
  return (
    <View style={styles.content}>
      <SectionTitle title="My vehicle" />
      <Card>
        <Text style={styles.cardTitle}>Vehicle profile not set up</Text>
        <Text style={styles.bodyText}>
          This prototype does not collect or store vehicle information. A production app would
          load your vehicle profile from a protected account service.
        </Text>
      </Card>
      <SectionTitle title="Connected sensors" />
      <Card>
        <InfoRow label="IMU" value="Not connected" warning />
        <InfoRow label="GPS" value="Not connected" warning />
        <InfoRow label="Camera / RFID evidence" value="Not connected" warning last />
      </Card>
    </View>
  );
}

function InfoRow({
  label,
  value,
  warning = false,
  last = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
  last?: boolean;
}) {
  return (
    <View style={[styles.infoRow, last && styles.infoRowLast]}>
      <Text style={styles.listTitle}>{label}</Text>
      <Badge warning={warning}>{value}</Badge>
    </View>
  );
}

function UserAlertHistory({ incidents }: { incidents: Incident[] }) {
  return (
    <View style={styles.content}>
      <SectionTitle title="Your alert history" hint="Stored for this session only" />
      {incidents.length === 0 ? (
        <EmptyState text="No alerts in this session. You can test the demo alert from Home." />
      ) : (
        incidents.map((incident) => (
          <Card key={incident.id}>
            <View style={styles.cardHeadingRow}>
              <Text style={styles.cardTitle}>{incident.id}</Text>
              <Badge warning={incident.response === 'Awaiting user'}>
                {incident.response}
              </Badge>
            </View>
            <Text style={styles.bodyText}>{incident.time} • {incident.location}</Text>
            <Text style={styles.mutedText}>{incident.trigger}</Text>
          </Card>
        ))
      )}
    </View>
  );
}

function AdminLocations({ incidents }: { incidents: Incident[] }) {
  return (
    <View style={styles.content}>
      <SectionTitle title="Accident locations" hint="Admin access" />
      <Card style={styles.permissionCard}>
        <Text style={styles.permissionTitle}>Location-only view</Text>
        <Text style={styles.bodyText}>
          Admin accounts can see incident locations and response status only. Vehicle identity,
          detailed evidence, and camera feeds are restricted to Super Admin.
        </Text>
      </Card>
      {incidents.length === 0 ? (
        <EmptyState text="No demo incidents yet. Trigger a test alert from a User account to see a location here." />
      ) : (
        incidents.map((incident) => (
          <Card key={incident.id}>
            <View style={styles.cardHeadingRow}>
              <Text style={styles.cardTitle}>{incident.location}</Text>
              <Badge warning={incident.response === 'Awaiting user'}>
                {incident.response}
              </Badge>
            </View>
            <Text style={styles.bodyText}>{incident.time} • {incident.id}</Text>
          </Card>
        ))
      )}
    </View>
  );
}

function AdminIncidents({ incidents }: { incidents: Incident[] }) {
  return (
    <View style={styles.content}>
      <SectionTitle title="Incident locations" hint="No identity details" />
      {incidents.length === 0 ? (
        <EmptyState text="No incidents in this demo session." />
      ) : (
        incidents.map((incident) => (
          <Card key={incident.id}>
            <Text style={styles.cardTitle}>{incident.location}</Text>
            <Text style={styles.bodyText}>{incident.time} • {incident.response}</Text>
          </Card>
        ))
      )}
    </View>
  );
}

function SuperAdminOverview({ incidents }: { incidents: Incident[] }) {
  return (
    <View style={styles.content}>
      <SectionTitle title="System overview" hint="Super Admin access" />
      <Card>
        <Text style={styles.cardTitle}>Integrations</Text>
        <InfoRow label="IMU / crash events" value="Not connected" warning />
        <InfoRow label="Backend / event stream" value="Not connected" warning />
        <InfoRow label="CARLA simulation" value="Not connected" warning />
        <InfoRow label="Live camera service" value="Not connected" warning last />
      </Card>
      <SectionTitle title="Session incidents" />
      {incidents.length === 0 ? (
        <EmptyState text="No incidents in this demo session." />
      ) : (
        incidents.map((incident) => <EvidenceCard key={incident.id} incident={incident} />)
      )}
    </View>
  );
}

function CameraFeeds() {
  return (
    <View style={styles.content}>
      <SectionTitle title="Live camera feeds" hint="Super Admin only" />
      <Card style={styles.cameraUnavailable}>
        <Text style={styles.cameraIcon}>CAM</Text>
        <Text style={styles.cardTitle}>Camera stream unavailable</Text>
        <Text style={styles.bodyText}>
          This standalone app has no camera service or video source. A live feed will only be
          shown after a protected streaming integration is configured.
        </Text>
      </Card>
      <Card style={styles.cameraUnavailable}>
        <Text style={styles.cameraIcon}>CAM</Text>
        <Text style={styles.cardTitle}>Junction camera • no connection</Text>
        <Text style={styles.mutedText}>No video is being captured or displayed.</Text>
      </Card>
    </View>
  );
}

function EvidenceCard({ incident }: { incident: Incident }) {
  return (
    <Card>
      <View style={styles.cardHeadingRow}>
        <Text style={styles.cardTitle}>{incident.id}</Text>
        <Badge warning={incident.response === 'Awaiting user'}>{incident.response}</Badge>
      </View>
      <Text style={styles.bodyText}>{incident.time} • {incident.location}</Text>
      <Text style={styles.mutedText}>Source: {incident.trigger}</Text>
      <Text style={styles.mutedText}>
        Vehicle / collision-partner identification: Not evaluated (no integration)
      </Text>
    </Card>
  );
}

function SuperAdminEvidence({ incidents }: { incidents: Incident[] }) {
  return (
    <View style={styles.content}>
      <SectionTitle title="Incident evidence" hint="Super Admin only" />
      {incidents.length === 0 ? (
        <EmptyState text="No incident evidence in this demo session." />
      ) : (
        incidents.map((incident) => <EvidenceCard key={incident.id} incident={incident} />)
      )}
    </View>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <Card style={styles.emptyCard}>
      <Text style={styles.emptyTitle}>Nothing to show yet</Text>
      <Text style={styles.bodyText}>{text}</Text>
    </Card>
  );
}

function CrashConfirmation({
  visible,
  onRespond,
}: {
  visible: boolean;
  onRespond: (response: IncidentResponse) => void;
}) {
  return (
    <Modal animationType="fade" onRequestClose={() => undefined} transparent visible={visible}>
      <View style={styles.modalBackdrop}>
        <View style={styles.alertCard}>
          <View style={styles.alertSymbol}>
            <Text style={styles.alertSymbolText}>!</Text>
          </View>
          <Text style={styles.alertEyebrow}>POSSIBLE CRASH DETECTED</Text>
          <Text style={styles.alertTitle}>Are you in an accident?</Text>
          <Text style={styles.alertText}>
            This demo alert keeps vibrating until you respond. If you are safe, select “No, false
            alarm.” This prototype does not contact emergency services.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => onRespond('Accident confirmed')}
            style={styles.dangerButton}
          >
            <Text style={styles.primaryButtonText}>Yes, accident happened</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => onRespond('False alarm')}
            style={styles.safeButton}
          >
            <Text style={styles.safeButtonText}>No, false alarm — I’m safe</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Workspace({
  role,
  onLogout,
  incidents,
  alarmPending,
  onTriggerAlert,
  onRespond,
}: {
  role: Role;
  onLogout: () => void;
  incidents: Incident[];
  alarmPending: boolean;
  onTriggerAlert: () => void;
  onRespond: (response: IncidentResponse) => void;
}) {
  const [activeTab, setActiveTab] = useState(roleTabs[role][0]);

  const renderContent = () => {
    if (role === 'user') {
      if (activeTab === 'My vehicle') return <MyVehicle />;
      if (activeTab === 'Alert history') return <UserAlertHistory incidents={incidents} />;
      return <UserHome onTriggerAlert={onTriggerAlert} />;
    }
    if (role === 'admin') {
      return activeTab === 'Incidents'
        ? <AdminIncidents incidents={incidents} />
        : <AdminLocations incidents={incidents} />;
    }
    if (activeTab === 'Live cameras') return <CameraFeeds />;
    if (activeTab === 'Evidence') return <SuperAdminEvidence incidents={incidents} />;
    return <SuperAdminOverview incidents={incidents} />;
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <AppHeader onLogout={onLogout} role={role} />
      <DemoBanner />
      <ScrollView
        contentContainerStyle={styles.tabsContent}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {roleTabs[role].map((tab) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab }}
            key={tab}
            onPress={() => setActiveTab(tab)}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={styles.pageContent}>{renderContent()}</ScrollView>
      <CrashConfirmation visible={alarmPending && role === 'user'} onRespond={onRespond} />
    </SafeAreaView>
  );
}

export default function App() {
  const [role, setRole] = useState<Role | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [alarmPending, setAlarmPending] = useState(false);

  useEffect(() => {
    if (!alarmPending) return undefined;

    Vibration.vibrate(700);
    const vibrationTimer = setInterval(() => Vibration.vibrate(700), 1400);
    return () => {
      clearInterval(vibrationTimer);
      Vibration.cancel();
    };
  }, [alarmPending]);

  const triggerDemoAlert = () => {
    const incident: Incident = {
      id: `DEMO-${String(incidents.length + 1).padStart(3, '0')}`,
      time: new Date().toLocaleTimeString(),
      location: 'Junction J1 (demo location)',
      response: 'Awaiting user',
      trigger: 'Manually triggered demo IMU event',
    };
    setIncidents((current) => [incident, ...current]);
    setAlarmPending(true);
  };

  const respondToAlert = (response: IncidentResponse) => {
    setIncidents((current) =>
      current.map((incident, index) =>
        index === 0 ? { ...incident, response } : incident,
      ),
    );
    setAlarmPending(false);
  };

  const logout = () => {
    setAlarmPending(false);
    setRole(null);
  };

  return role ? (
    <Workspace
      alarmPending={alarmPending}
      incidents={incidents}
      onLogout={logout}
      onRespond={respondToAlert}
      onTriggerAlert={triggerDemoAlert}
      role={role}
    />
  ) : (
    <LoginScreen onLogin={setRole} />
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F7FB',
  },
  loginPage: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  loginCard: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: '#E5EAF2',
  },
  brand: {
    color: '#2563EB',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 2.4,
  },
  loginTitle: {
    color: '#101828',
    fontSize: 30,
    fontWeight: '800',
    marginTop: 18,
  },
  subtitle: {
    color: '#667085',
    fontSize: 14,
    marginTop: 5,
    marginBottom: 24,
  },
  fieldLabel: {
    color: '#344054',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  roleChoices: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 18,
  },
  roleChoice: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 10,
    paddingVertical: 11,
  },
  roleChoiceSelected: {
    backgroundColor: '#EFF6FF',
    borderColor: '#2563EB',
  },
  roleChoiceText: {
    color: '#475467',
    fontSize: 12,
    fontWeight: '700',
  },
  roleChoiceTextSelected: {
    color: '#1D4ED8',
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 10,
    color: '#101828',
    fontSize: 15,
    paddingHorizontal: 13,
    paddingVertical: 12,
    marginBottom: 15,
  },
  primaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1D4ED8',
    borderRadius: 11,
    paddingVertical: 14,
    marginTop: 5,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  dangerButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#B42318',
    borderRadius: 11,
    paddingVertical: 14,
    marginTop: 18,
  },
  safeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ECFDF3',
    borderColor: '#ABEFC6',
    borderWidth: 1,
    borderRadius: 11,
    paddingVertical: 14,
    marginTop: 10,
  },
  safeButtonText: {
    color: '#027A48',
    fontSize: 14,
    fontWeight: '800',
  },
  errorText: {
    color: '#B42318',
    fontSize: 13,
    marginBottom: 5,
  },
  demoNote: {
    borderTopWidth: 1,
    borderTopColor: '#EAECF0',
    marginTop: 20,
    paddingTop: 16,
  },
  demoNoteTitle: {
    color: '#344054',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 8,
  },
  demoCredential: {
    color: '#475467',
    fontSize: 12,
    lineHeight: 20,
  },
  demoDisclaimer: {
    color: '#98A2B3',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 10,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 14,
  },
  brandSmall: {
    color: '#2563EB',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
  },
  headerTitle: {
    color: '#101828',
    fontSize: 21,
    fontWeight: '800',
    marginTop: 3,
  },
  logoutButton: {
    borderColor: '#D0D5DD',
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  logoutText: {
    color: '#344054',
    fontSize: 12,
    fontWeight: '700',
  },
  demoBanner: {
    backgroundColor: '#FFFAEB',
    borderColor: '#FEDF89',
    borderRadius: 12,
    borderWidth: 1,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
  },
  demoBannerTitle: {
    color: '#93370D',
    fontSize: 12,
    fontWeight: '800',
  },
  demoBannerText: {
    color: '#93370D',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  tabsContent: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  tab: {
    borderColor: '#D0D5DD',
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  tabActive: {
    backgroundColor: '#101828',
    borderColor: '#101828',
  },
  tabText: {
    color: '#475467',
    fontSize: 12,
    fontWeight: '700',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  pageContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingBottom: 30,
    paddingTop: 4,
  },
  content: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    gap: 12,
  },
  sectionHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
    marginBottom: 2,
  },
  sectionTitle: {
    color: '#101828',
    fontSize: 17,
    fontWeight: '800',
  },
  sectionHint: {
    color: '#667085',
    fontSize: 11,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderColor: '#EAECF0',
    borderRadius: 15,
    borderWidth: 1,
    padding: 16,
  },
  cardHeadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  cardTitle: {
    color: '#101828',
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '800',
  },
  bodyText: {
    color: '#475467',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  mutedText: {
    color: '#667085',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 5,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  badgeGood: {
    backgroundColor: '#ECFDF3',
  },
  badgeWarning: {
    backgroundColor: '#FFFAEB',
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  badgeGoodText: {
    color: '#027A48',
  },
  badgeWarningText: {
    color: '#B54708',
  },
  infoCard: {
    backgroundColor: '#F8FAFC',
  },
  workflowRow: {
    alignItems: 'flex-start',
    borderBottomColor: '#EAECF0',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 13,
  },
  workflowRowLast: {
    borderBottomWidth: 0,
    paddingBottom: 2,
  },
  stepNumber: {
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    borderRadius: 20,
    height: 27,
    justifyContent: 'center',
    width: 27,
  },
  stepNumberText: {
    color: '#1D4ED8',
    fontSize: 12,
    fontWeight: '800',
  },
  workflowCopy: {
    flex: 1,
  },
  listTitle: {
    color: '#344054',
    fontSize: 13,
    fontWeight: '700',
  },
  infoRow: {
    alignItems: 'center',
    borderBottomColor: '#EAECF0',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 12,
  },
  infoRowLast: {
    borderBottomWidth: 0,
    paddingBottom: 0,
  },
  permissionCard: {
    backgroundColor: '#F8FAFC',
  },
  permissionTitle: {
    color: '#1D4ED8',
    fontSize: 13,
    fontWeight: '800',
  },
  emptyCard: {
    alignItems: 'flex-start',
    backgroundColor: '#FFFFFF',
  },
  emptyTitle: {
    color: '#344054',
    fontSize: 14,
    fontWeight: '800',
  },
  cameraUnavailable: {
    alignItems: 'center',
    backgroundColor: '#101828',
    minHeight: 150,
    justifyContent: 'center',
    padding: 22,
  },
  cameraIcon: {
    color: '#98A2B3',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
    marginBottom: 8,
  },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(16, 24, 40, 0.72)',
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  alertCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    maxWidth: 440,
    padding: 24,
    width: '100%',
  },
  alertSymbol: {
    alignItems: 'center',
    backgroundColor: '#FEF3F2',
    borderRadius: 28,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  alertSymbolText: {
    color: '#B42318',
    fontSize: 26,
    fontWeight: '900',
  },
  alertEyebrow: {
    color: '#B42318',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1,
    marginTop: 18,
  },
  alertTitle: {
    color: '#101828',
    fontSize: 24,
    fontWeight: '900',
    marginTop: 6,
  },
  alertText: {
    color: '#475467',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
  },
});
