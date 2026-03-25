export interface TestCase {
  name: string;
  run: () => Promise<void>;
}
