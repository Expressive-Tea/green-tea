export interface Scenario {
  name: string;        // key
  title: string;       // display
  method: 'GET' | 'POST';
  path: string;        // route path (no host)
  body?: unknown;      // JSON body for POST
  approximation?: boolean;
}

// The always-valid validation body — every framework takes the success path.
export const VALIDATE_BODY = { email: 'bench@example.com' };

export const SCENARIOS: Scenario[] = [
  { name: 'hello',    title: 'JSON hello (overhead)', method: 'GET',  path: '/hello' },
  { name: 'param',    title: 'Route param',           method: 'GET',  path: '/users/42' },
  { name: 'pipeline', title: 'Pipeline (3 steps)',    method: 'GET',  path: '/pipeline', approximation: true },
  { name: 'validate', title: 'POST JSON + validation',method: 'POST', path: '/validate', body: VALIDATE_BODY },
];

// green-tea-only step-scaling routes
export const STEP_ROUTES = [
  { name: 'steps0', steps: 0, path: '/steps/0' },
  { name: 'steps3', steps: 3, path: '/steps/3' },
  { name: 'steps5', steps: 5, path: '/steps/5' },
];
