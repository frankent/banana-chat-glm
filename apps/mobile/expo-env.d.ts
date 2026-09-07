// NOTE: intentionally NOT referencing `expo/types` — its react-native-web
// augmentation (`interface TextStyle` / `interface ViewStyle`) declaration-
// merges over RN 0.87's *type-alias* style exports and shadows them with
// empty interfaces, breaking every StyleSheet in this native-only app.
// Re-add only if web (react-native-web) support lands and RN/expo fix the merge.
