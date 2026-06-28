import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLList, GraphQLNonNull, graphql, subscribe, parse } from 'graphql';
import { createApp, Route, Post, Sse, Module, body, needs, isAsyncIterable, Rooms } from '../src/index';

interface Message { text: string }
const store: Message[] = [];
const MessageType = new GraphQLObjectType({ name: 'Message', fields: { text: { type: GraphQLString } } });

function buildSchema(rooms: Rooms): GraphQLSchema {
  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: {
      messages: { type: new GraphQLList(MessageType), resolve: () => store },
    } }),
    mutation: new GraphQLObjectType({ name: 'Mutation', fields: {
      postMessage: { type: MessageType, args: { text: { type: new GraphQLNonNull(GraphQLString) } },
        resolve: (_root, { text }: { text: string }) => { const m = { text }; store.push(m); rooms.room('messages').push(m); return m; } },
    } }),
    subscription: new GraphQLObjectType({ name: 'Subscription', fields: {
      messageAdded: { type: MessageType,
        subscribe: () => rooms.room<Message>('messages'),   // Channel is the AsyncIterable source
        resolve: (payload: Message) => payload },
    } }),
  });
}

@Route('/graphql')
class GraphQLController {
  @Post('')
  async run(@body() input: any, @needs('rooms') rooms: Rooms) {
    return graphql({ schema: buildSchema(rooms), source: input?.query ?? '', variableValues: input?.variables });
  }

  @Sse('/stream')
  async stream(@needs('rooms') rooms: Rooms) {
    const result = await subscribe({ schema: buildSchema(rooms), document: parse('subscription { messageAdded { text } }') });
    if (!isAsyncIterable(result)) throw new Error('subscription failed');   // subscribe() returns a single ExecutionResult on error
    return result;
  }
}

@Module({ mountpoint: '/', controllers: [GraphQLController] })
class GraphQLModule {}

export const app = createApp({ modules: [GraphQLModule] });

if (require.main === module) {
  app.listen(4200).then(() => console.log('graphql on http://localhost:4200/graphql'));
}
