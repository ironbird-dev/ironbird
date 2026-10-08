import { useState } from 'react';
import { FlatList, Pressable, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { store } from './src/app/instance';
import type { AppDispatch } from './src/store/store';
import { added, toggled, type AppState, type Todo } from './src/store/todos';

export default function App() {
  return (
    <Provider store={store}>
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" />
        <TodoScreen />
      </SafeAreaProvider>
    </Provider>
  );
}

function TodoScreen() {
  const items = useSelector((state: AppState) => state.todos.items);
  const sync = useSelector((state: AppState) => state.sync);
  const dispatch = useDispatch<AppDispatch>();
  const [title, setTitle] = useState('');

  const add = (): void => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    dispatch(added({ title: trimmed }));
    setTitle('');
  };

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>To-dos</Text>
      <Text style={styles.status} testID="sync-status">
        {sync.inFlight === 0 ? 'All changes sent' : `Saving ${sync.inFlight}…`}
      </Text>
      {sync.lastError ? <Text style={styles.error}>{sync.lastError}</Text> : null}
      <View style={styles.addRow}>
        <TextInput value={title} onChangeText={setTitle} onSubmitEditing={add} placeholder="What needs doing?" style={styles.input} testID="new-title" />
        <Pressable onPress={add} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]} accessibilityRole="button">
          <Text style={styles.buttonText}>Add</Text>
        </Pressable>
      </View>
      <FlatList data={items} keyExtractor={(item) => item.id} renderItem={({ item }) => <TodoRow todo={item} onToggle={() => dispatch(toggled({ id: item.id }))} />} />
    </SafeAreaView>
  );
}

function TodoRow({ todo, onToggle }: { todo: Todo; onToggle: () => void }) {
  const saved = todo.syncedRev >= todo.rev;
  return (
    <Pressable onPress={onToggle} style={styles.row} accessibilityRole="checkbox" accessibilityState={{ checked: todo.done }}>
      <Text style={[styles.rowTitle, todo.done && styles.done]}>
        {todo.done ? '☑' : '☐'} {todo.title}
      </Text>
      <Text style={saved ? styles.saved : styles.saving}>{saved ? 'Saved' : 'Saving…'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff', paddingHorizontal: 20 },
  title: { fontSize: 30, fontWeight: '700', marginTop: 12 },
  status: { fontSize: 13, color: '#666666', marginBottom: 8 },
  error: { fontSize: 13, color: '#b42318', marginBottom: 8 },
  addRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input: { flex: 1, borderWidth: 1, borderColor: '#cccccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  button: { backgroundColor: '#1f6feb', paddingHorizontal: 16, justifyContent: 'center', borderRadius: 8 },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#ffffff', fontWeight: '600' },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#dddddd' },
  rowTitle: { fontSize: 16, flexShrink: 1 },
  done: { color: '#888888', textDecorationLine: 'line-through' },
  saved: { fontSize: 13, color: '#1a7f37' },
  saving: { fontSize: 13, color: '#9a6700' },
});
