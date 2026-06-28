import { createApp, Step, Route, Ws, Module, Unauthorized, param, needs, inbound, Rooms } from '../src/index';

@Step({ provides: 'user', needs: [] })
class Authenticate {
  run(ctx: any) {
    const token = ctx.query?.token;            // steps read ctx directly (no @query on steps)
    if (!token) throw new Unauthorized('token required');
    return { user: { id: String(token) } };
  }
}

@Route('/chat')
class ChatController {
  @Ws('/:room')
  join(@param('room') room: string, @needs('user') user: any, @needs('rooms') rooms: Rooms, @inbound() incoming: AsyncIterable<string>) {
    const hub = rooms.room<string>(room);
    (async () => { for await (const msg of incoming) hub.push(`${user.id}: ${msg}`); })().catch(() => {});   // fire-and-forget pump
    return hub;                                 // broadcast as the outbound channel
  }
}

@Module({ mountpoint: '/', steps: [Authenticate], controllers: [ChatController] })
class ChatModule {}

export const app = createApp({ modules: [ChatModule] });

if (require.main === module) {
  app.listen(4100).then(() => console.log('chat on ws://localhost:4100/chat/:room?token=...'));
}
