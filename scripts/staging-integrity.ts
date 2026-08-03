export type StagingAction = 'publish' | 'skip';

export function decideStagingPublish(localIntegrity: string, existingIntegrity?: string): StagingAction {
  if (existingIntegrity === undefined) return 'publish';
  if (existingIntegrity === localIntegrity) return 'skip';

  throw new Error('Version already exists in Verdaccio with different contents');
}

if (require.main === module) {
  const [, , localIntegrity, existingIntegrity] = process.argv;
  console.log(decideStagingPublish(localIntegrity, existingIntegrity));
}
