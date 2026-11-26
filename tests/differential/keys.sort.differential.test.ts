import { differential, s } from './differential.harness';
import { sorted } from './differential.normalizers';

const DATA = [
  'RPUSH l 3 1 2 10 5',
  'MSET w_1 50 w_2 40 w_3 30 w_5 10 w_10 20',
  'MSET o_1 one o_2 two o_3 three o_5 five o_10 ten',
  'HSET h_1 f a1 n 5',
  'HSET h_2 f a2 n 4',
  'HSET h_3 f a3 n 3',
  'HSET h_5 f a5 n 2',
  'HSET h_10 f a10 n 1',
];

differential('keys sort', [
  // numeric / alpha / desc / limit
  s('SORT numeric', ['RPUSH l 3 1 2 10 5', 'SORT l', 'SORT l DESC', 'SORT l ASC', 'SORT_RO l DESC']),
  s('SORT ALPHA', ['RPUSH l banana apple Cherry 10 9', 'SORT l ALPHA', 'SORT l ALPHA DESC', 'SORT l']),
  s('SORT numeric with floats and exponent', ['RPUSH l 1.5 -2 1e2 0x10 inf -inf', 'SORT l']),
  s('SORT numeric value with leading space', ['RPUSH m 3 " 2" 1', 'SORT m', 'RPUSH n 1 "2 "', 'SORT n']),
  s('SORT LIMIT', [
    'RPUSH l 3 1 2 10 5', 'SORT l LIMIT 0 2', 'SORT l LIMIT 1 2 DESC', 'SORT l LIMIT 4 10', 'SORT l LIMIT 10 2', 'SORT l LIMIT -1 2',
    'SORT l LIMIT 0 -1', 'SORT l LIMIT 0 0', 'SORT l LIMIT 1 -5',
  ]),
  s('SORT LIMIT errors', ['RPUSH l 1', 'SORT l LIMIT', 'SORT l LIMIT 0', 'SORT l LIMIT a 1', 'SORT l LIMIT 0 b']),
  s('SORT sets and zsets', ['SADD s 5 3 9 1', 'SORT s', 'SORT s DESC LIMIT 0 2', 'ZADD z 1 c 2 b 3 a', 'SORT z ALPHA', 'SORT z BY nosort', 'SORT z BY nosort DESC', 'SORT z BY nosort LIMIT 1 1']),
  s('SORT set ALPHA', ['SADD s b a c', 'SORT s ALPHA', 'SORT s ALPHA DESC']),
  s('SORT missing key and wrong type', ['SORT missing', 'SORT missing ALPHA STORE dst', 'EXISTS dst', 'SET str v', 'SORT str', 'HSET h f v', 'SORT h']),
  s('SORT non-numeric values', ['RPUSH l a 1 b', 'SORT l', 'SORT l ALPHA']),
  s('SORT syntax errors', ['RPUSH l 1', 'SORT l FOO', 'SORT l BY', 'SORT l GET', 'SORT l STORE', 'SORT', 'SORT l ALPHA FOO']),

  // BY / GET patterns
  s('SORT BY weight keys', [...DATA, 'SORT l BY w_*', 'SORT l BY w_* DESC', 'SORT l BY missing_*', 'SORT l BY w_* LIMIT 0 2']),
  s('SORT BY nosort keeps order', [...DATA, 'SORT l BY nosort', 'SORT l BY nosort GET o_*', 'SORT l BY nosort DESC']),
  s('SORT BY hash field', [...DATA, 'SORT l BY h_*->n', 'SORT l BY h_*->f ALPHA', 'SORT l BY h_*->missing']),
  s('SORT GET patterns', [...DATA, 'SORT l GET o_*', 'SORT l GET # GET o_*', 'SORT l GET h_*->f', 'SORT l GET missing_* GET #', 'SORT l BY w_* GET # GET w_*']),
  s('SORT GET hash field edge patterns', [...DATA, 'SORT l GET h_*->', 'SORT l GET ->f', 'SORT l GET h_*->f->x', 'SORT l GET nostar', 'SORT l GET h_1->f']),
  s('SORT BY pattern without star', [...DATA, 'SORT l BY w_1', 'SORT l BY constant ALPHA', 'SORT l BY w_1 DESC']),
  s('SORT BY with non-numeric weights', ['RPUSH l 1 2 3', 'MSET w_1 x w_2 2 w_3 1', 'SORT l BY w_*', 'SORT l BY w_* ALPHA']),
  s('SORT GET on wrong-type pattern keys', ['RPUSH l 1 2', 'RPUSH o_1 x', 'SET o_2 y', 'SORT l GET o_*', 'SET h_1 str', 'SORT l GET h_*->f']),
  s('SORT RESP3 nulls', [...DATA, 'SORT l GET missing_*', 'SORT l GET # GET h_*->nofield']),

  // STORE
  s('SORT STORE', [...DATA, 'SORT l STORE dst', 'LRANGE dst 0 -1', 'TYPE dst', 'SORT l BY w_* GET o_* STORE dst', 'LRANGE dst 0 -1']),
  s('SORT STORE empty deletes destination', ['SET dst v', 'SORT missing STORE dst', 'EXISTS dst', 'RPUSH l 1', 'SORT l LIMIT 5 5 STORE dst', 'EXISTS dst']),
  s('SORT STORE nil GET becomes empty string', ['RPUSH l 1 2', 'SORT l GET missing_* STORE dst', 'LRANGE dst 0 -1', 'LLEN dst']),
  s('SORT STORE onto source', ['RPUSH l 3 1 2', 'SORT l DESC STORE l', 'LRANGE l 0 -1']),
  s('SORT STORE overwrites other type and TTL', ['RPUSH l 2 1', 'SET dst v EX 100', 'SORT l STORE dst', 'TTL dst', 'TYPE dst']),

  // SORT_RO
  s('SORT_RO rejects STORE', ['RPUSH l 3 1 2', 'SORT_RO l STORE dst', 'SORT_RO l LIMIT 0 2 DESC', 'SORT_RO l BY nosort', 'SORT_RO', 'SORT_RO missing']),
  s('SORT_RO with patterns', [...DATA, 'SORT_RO l BY w_* GET # GET o_*', 'SORT_RO l BY h_*->n GET h_*->f ALPHA']),

  // sets ordering under BY nosort is hash order: compare as a set
  s('SORT hashtable set BY nosort', ['SADD s alpha beta gamma delta', { cmd: 'SORT s BY nosort', norm: sorted }, 'SORT s ALPHA LIMIT 0 2']),
]);
