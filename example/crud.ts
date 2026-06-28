import {
  createApp, Provider, Route,
  Get, Post, Put, Patch, Delete,
  Module, needs, param, query, body, NotFound,
} from '../src/index';

interface Todo { id: string; title: string; done: boolean }

interface Store {
  todos: Map<string, Todo>;
  next(): string;
}

@Provider({ provides: 'store' })
class TodoStore {
  private counter = 0;
  private readonly todos: Map<string, Todo> = new Map();

  provide(): { store: Store } {
    const store: Store = {
      todos: this.todos,
      next: () => String(++this.counter),
    };
    return { store };
  }
}

@Route('/todos')
class TodoController {
  @Get('/')
  list(@needs('store') store: Store, @query('done') done: string | undefined): Todo[] {
    const all = [...store.todos.values()];
    if (done !== undefined) {
      const flag = done === 'true';
      return all.filter((t) => t.done === flag);
    }
    return all;
  }

  @Get('/:id')
  get(@needs('store') store: Store, @param('id') id: string): Todo {
    const todo = store.todos.get(id);
    if (!todo) throw new NotFound(`todo ${id} not found`);
    return todo;
  }

  @Post('/')
  create(@needs('store') store: Store, @body() data: Record<string, unknown>): Todo {
    const id = store.next();
    const todo: Todo = { id, title: String(data.title ?? ''), done: false };
    store.todos.set(id, todo);
    return todo;
  }

  @Put('/:id')
  replace(@needs('store') store: Store, @param('id') id: string, @body() data: Record<string, unknown>): Todo {
    if (!store.todos.has(id)) throw new NotFound(`todo ${id} not found`);
    const todo: Todo = { id, title: String(data.title ?? ''), done: Boolean(data.done ?? false) };
    store.todos.set(id, todo);
    return todo;
  }

  @Patch('/:id')
  merge(@needs('store') store: Store, @param('id') id: string, @body() data: Record<string, unknown>): Todo {
    const todo = store.todos.get(id);
    if (!todo) throw new NotFound(`todo ${id} not found`);
    const updated: Todo = {
      id,
      title: 'title' in data ? String(data.title) : todo.title,
      done: 'done' in data ? Boolean(data.done) : todo.done,
    };
    store.todos.set(id, updated);
    return updated;
  }

  @Delete('/:id')
  remove(@needs('store') store: Store, @param('id') id: string): { deleted: string } {
    if (!store.todos.has(id)) throw new NotFound(`todo ${id} not found`);
    store.todos.delete(id);
    return { deleted: id };
  }
}

@Module({ mountpoint: '/api', providers: [TodoStore], controllers: [TodoController] })
class TodoModule {}

export const app = createApp({ modules: [TodoModule] });

if (require.main === module) {
  app.listen(3300).then(() => console.log('green-tea crud on http://localhost:3300'));
}
