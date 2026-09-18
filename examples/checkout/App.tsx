import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Image, LayoutAnimation, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, UIManager, View } from 'react-native';
import type { CheckoutEvent, CheckoutState } from './src/core/checkout';
import { appCore } from './src/core/instance';

// Metro resolves static image assets through its asset plugin, which only recognizes the
// synchronous require() form, so `import` here would not decode to a module Image can render.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro asset resolution needs require(), not import.
const productA = require('./assets/product-a.png');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro asset resolution needs require(), not import.
const productB = require('./assets/product-b.png');

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function useCheckout(): CheckoutState {
  return useSyncExternalStore(appCore.subscribe, appCore.getSnapshot, appCore.getSnapshot);
}

/** Sends a command from a button; the core throws on an invalid transition, which the screen shows instead of crashing. */
function useSend(): { send: (event: CheckoutEvent) => void; notice: string | null } {
  const [notice, setNotice] = useState<string | null>(null);
  return {
    notice,
    send: (event) => {
      try {
        appCore.send(event);
        setNotice(null);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Fades and slides its children in whenever `token` changes; instant when motion is reduced. */
function Reveal({ token, motion, children }: { token: string; motion: boolean; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const shift = useRef(new Animated.Value(0)).current;
  const previous = useRef(token);
  useEffect(() => {
    // Hoisted above the token guard: a motion-only re-run (full -> reduced mid-animation) must
    // still snap to rest even though `previous.current === token` already, or `anim.stop()` below
    // would leave opacity/shift parked at whatever partial values the native timing had reached.
    if (!motion) {
      opacity.setValue(1);
      shift.setValue(0);
      previous.current = token;
      return;
    }
    if (previous.current === token) return;
    previous.current = token;
    opacity.setValue(0);
    shift.setValue(12);
    // Native driver: the animation runs on the UI thread, exactly the blind spot Q5 asks about.
    const anim = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.timing(shift, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]);
    anim.start();
    // Stop a still-running reveal when motion toggles to reduced mid-flight (or on unmount), so
    // the toggle is authoritative instead of letting an animation that already started finish
    // regardless of the current motion setting.
    return () => anim.stop();
  }, [token, motion, opacity, shift]);
  return <Animated.View style={{ opacity, transform: [{ translateY: shift }] }}>{children}</Animated.View>;
}

export default function App() {
  const state = useCheckout();
  const { send, notice } = useSend();
  const motion = state.ui.motion === 'full';
  const itemCount = state.cart.items.reduce((sum, item) => sum + item.qty, 0);

  // LayoutAnimation must be configured before the render that changes the list. State changes
  // arrive from the core outside React, so the subscription is the moment to arm it.
  useEffect(
    () =>
      appCore.subscribe(() => {
        if (appCore.getSnapshot().ui.motion === 'full') LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      }),
    [],
  );

  // The image swap is part of motion, not just Animated and LayoutAnimation (spec D2): with
  // motion full the header alternates between the two bundled images on every cart change, so
  // each harness step decodes a new image; with motion reduced it stays on one image so the
  // reduced arm of the Q5 comparison stops decoding a new image per step too.
  const [cartVersion, setCartVersion] = useState(0);
  useEffect(() => {
    if (!motion) return;
    setCartVersion((version) => version + 1);
  }, [state.cart, motion]);
  const hero = motion && cartVersion % 2 !== 0 ? productB : productA;

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} testID="screen">
        <Text style={styles.title}>Checkout</Text>
        <Text style={styles.motion}>motion: {state.ui.motion}</Text>

        <View style={styles.section}>
          <Image source={hero} style={styles.hero} resizeMode="cover" />
          <Text style={styles.heading}>Cart · {itemCount} item{itemCount === 1 ? '' : 's'}</Text>
          {state.cart.items.map((item) => (
            <View key={item.sku} style={styles.row}>
              <Text style={styles.rowText}>
                {item.qty} × {item.name}
              </Text>
              <Text style={styles.rowText}>{dollars(item.qty * item.unitCents)}</Text>
            </View>
          ))}
          <Text style={styles.subtotal}>Subtotal {dollars(state.cart.subtotalCents)}</Text>
          <View style={styles.buttons}>
            <Button label="Add haircut" onPress={() => send({ type: 'cart.addItem', sku: 'cut-45', qty: 1 })} />
            <Button label="Add shampoo" onPress={() => send({ type: 'cart.addItem', sku: 'shampoo-12', qty: 1 })} />
            <Button label="Clear" onPress={() => send({ type: 'cart.clear' })} />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.heading}>Payment</Text>
          <Reveal token={`${state.payment.status}:${state.payment.error ?? ''}`} motion={motion}>
            <View style={[styles.card, cardStyle(state.payment.status)]}>
              <Text style={styles.cardStatus}>{state.payment.status}</Text>
              {state.payment.method ? <Text style={styles.cardText}>method: {state.payment.method}</Text> : null}
              {state.payment.paymentId ? <Text style={styles.cardText}>{state.payment.paymentId}</Text> : null}
              {state.payment.error ? <Text style={styles.cardError}>{state.payment.error}</Text> : null}
            </View>
          </Reveal>
          <View style={styles.buttons}>
            <Button label="Pay with card" onPress={() => send({ type: 'payment.start', method: 'card' })} />
            <Button label="Pay with saved card" onPress={() => send({ type: 'payment.start', method: 'saved' })} />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.heading}>Receipt</Text>
          <Reveal token={`${state.order.status}:${state.order.orderId ?? ''}`} motion={motion}>
            {state.order.status === 'completed' ? (
              <View style={styles.receipt}>
                <Text style={styles.receiptText}>Order {state.order.orderId}</Text>
                <Text style={styles.receiptTotal}>{dollars(state.order.totalCents)}</Text>
              </View>
            ) : (
              <Text style={styles.muted}>{state.order.status === 'confirmed' ? 'Confirmed, awaiting payment' : 'No order yet'}</Text>
            )}
          </Reveal>
        </View>

        <Button label={motion ? 'Reduce motion' : 'Full motion'} onPress={() => send({ type: 'ui.setMotion', motion: motion ? 'reduced' : 'full' })} />
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Text style={styles.muted}>reader {state.reader.connected ? 'connected' : 'disconnected'}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]} accessibilityRole="button">
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const cardStyle = (status: CheckoutState['payment']['status']) => {
  switch (status) {
    case 'succeeded':
      return styles.cardSucceeded;
    case 'failed':
      return styles.cardFailed;
    case 'idle':
      return styles.cardIdle;
    default:
      return styles.cardBusy;
  }
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 20, gap: 16 },
  title: { fontSize: 30, fontWeight: '700' },
  motion: { fontSize: 13, color: '#666666' },
  section: { gap: 8 },
  hero: { width: '100%', height: 120, borderRadius: 12 },
  heading: { fontSize: 18, fontWeight: '600', marginTop: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#dddddd' },
  rowText: { fontSize: 16 },
  subtotal: { fontSize: 16, fontWeight: '600', textAlign: 'right' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { backgroundColor: '#1f6feb', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#ffffff', fontWeight: '600' },
  card: { padding: 14, borderRadius: 12, gap: 4 },
  cardIdle: { backgroundColor: '#f2f2f2' },
  cardBusy: { backgroundColor: '#fff4cc' },
  cardSucceeded: { backgroundColor: '#dcf5e3' },
  cardFailed: { backgroundColor: '#fde2e1' },
  cardStatus: { fontSize: 20, fontWeight: '700' },
  cardText: { fontSize: 14, color: '#333333' },
  cardError: { fontSize: 14, color: '#b42318' },
  receipt: { padding: 14, borderRadius: 12, backgroundColor: '#eef4ff', gap: 4 },
  receiptText: { fontSize: 16 },
  receiptTotal: { fontSize: 24, fontWeight: '700' },
  muted: { color: '#777777' },
  notice: { color: '#b42318' },
});
