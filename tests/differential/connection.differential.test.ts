import { differential, s, v } from './differential.harness';
import { anyNumber, clientInfo, digits, hello, shape } from './differential.normalizers';

// connection-level commands: PING / ECHO / SELECT / HELLO / AUTH / RESET / QUIT and CLIENT name / id / reply / kill
differential('connection', [
  // PING / ECHO
  s('PING without argument', ['PING']),
  s('PING with a message', ['PING hello', 'PING ""']),
  s('PING with two arguments is an arity error', ['PING a b']),
  s('ECHO returns its argument', ['ECHO hello', 'ECHO ""', 'ECHO "a\\r\\nb"']),
  s('ECHO arity errors', ['ECHO', 'ECHO a b']),

  // SELECT
  s('SELECT valid indexes', ['SELECT 0', 'SET k 0', 'SELECT 15', 'SET k 15', 'GET k', 'SELECT 0', 'GET k']),
  s('SELECT out of range', ['SELECT 16', 'SELECT -1', 'SELECT 100000000000000000000']),
  s('SELECT non-integer', ['SELECT abc', 'SELECT 1.5', 'SELECT ""', 'SELECT " 1"']),
  s('SELECT arity', ['SELECT', 'SELECT 1 2']),
  s('SELECT isolates keyspaces per connection', ['SELECT 3', 'SET k v', { c: 1, cmd: 'GET k' }, { c: 1, cmd: 'SELECT 3' }, { c: 1, cmd: 'GET k' }]),

  // HELLO
  s('HELLO without arguments', [{ cmd: 'HELLO', norm: hello }]),
  s('HELLO 2 switches to RESP2', [{ cmd: 'HELLO 2', norm: hello }, 'HSET h f v', 'HGETALL h']),
  s('HELLO 3 switches to RESP3', [{ cmd: 'HELLO 3', norm: hello }, 'HSET h f v', 'HGETALL h']),
  s('HELLO 4 is unsupported', ['HELLO 4', 'HELLO 1', 'HELLO 0']),
  s('HELLO non-integer protocol', ['HELLO abc', 'HELLO 3.0', 'HELLO -3']),
  s('HELLO 3 AUTH default with any password (nopass user)', [{ cmd: 'HELLO 3 AUTH default whatever', norm: hello }]),
  s('HELLO AUTH unknown user', ['HELLO 3 AUTH nouser pw', 'HELLO 2 AUTH nouser pw']),
  s('HELLO AUTH with a missing password', ['HELLO 3 AUTH default', 'HELLO 2 AUTH']),
  s('HELLO SETNAME sets the name', [{ cmd: 'HELLO 3 SETNAME myconn', norm: hello }, 'CLIENT GETNAME']),
  s('HELLO SETNAME with invalid characters', ['HELLO 3 SETNAME "a b"', 'HELLO 2 SETNAME "a\\nb"', 'CLIENT GETNAME']),
  s('HELLO SETNAME without a value', ['HELLO 3 SETNAME']),
  s('HELLO unknown option', ['HELLO 2 bogus', 'HELLO 3 SETNAME x bogus']),
  s('HELLO AUTH and SETNAME together', [{ cmd: 'HELLO 2 AUTH default x SETNAME both', norm: hello }, 'CLIENT GETNAME']),
  s('HELLO without protocol but with options', ['HELLO SETNAME x']),

  // AUTH
  s('AUTH without a configured password', ['AUTH foo']),
  s('AUTH with an unknown user', ['AUTH nouser pass']),
  s('AUTH default user with any password', ['AUTH default whatever']),
  s('AUTH arity', ['AUTH', 'AUTH a b c']),

  // CLIENT SETNAME / GETNAME
  s('CLIENT GETNAME without a name', ['CLIENT GETNAME']),
  s('CLIENT SETNAME then GETNAME', ['CLIENT SETNAME worker-1', 'CLIENT GETNAME']),
  s('CLIENT SETNAME empty clears the name', ['CLIENT SETNAME x', 'CLIENT SETNAME ""', 'CLIENT GETNAME']),
  s('CLIENT SETNAME rejects spaces and newlines', ['CLIENT SETNAME "a b"', 'CLIENT SETNAME "a\\nb"', 'CLIENT SETNAME "a\\x01b"', 'CLIENT GETNAME']),
  s('CLIENT SETNAME accepts punctuation', ['CLIENT SETNAME "a-b_c.d:e!~"', 'CLIENT GETNAME']),
  s('CLIENT SETNAME arity', ['CLIENT SETNAME', 'CLIENT SETNAME a b', 'CLIENT GETNAME x']),
  s('CLIENT names are per connection', ['CLIENT SETNAME one', { c: 1, cmd: 'CLIENT GETNAME' }]),

  // CLIENT ID / INFO / LIST
  s('CLIENT ID is an integer', [{ cmd: 'CLIENT ID', norm: anyNumber }]),
  s('CLIENT ID arity', ['CLIENT ID x']),
  s('CLIENT INFO fields', [{ cmd: 'CLIENT INFO', norm: clientInfo }],
    v('CLIENT INFO gained lib-name/lib-ver (7.2), watch (7.4), io-thread (8.0) and tot-net-in/tot-net-out/tot-cmds (8.0)')),
  s('CLIENT LIST TYPE bogus', ['CLIENT LIST TYPE bogus']),
  s('CLIENT LIST TYPE pubsub without subscribers', ['CLIENT LIST TYPE pubsub']),
  s('CLIENT LIST TYPE master and replica are empty', ['CLIENT LIST TYPE master', 'CLIENT LIST TYPE replica', 'CLIENT LIST TYPE slave']),
  s('CLIENT LIST ID with a non-integer', ['CLIENT LIST ID abc', 'CLIENT LIST ID 1 abc']),
  s('CLIENT LIST ID with an unknown id', ['CLIENT LIST ID 999999']),
  s('CLIENT LIST ID with no ids', ['CLIENT LIST ID']),
  s('CLIENT LIST unknown option', ['CLIENT LIST bogus', 'CLIENT LIST TYPE']),
  s('CLIENT LIST zero and negative ids', ['CLIENT LIST ID 0', 'CLIENT LIST ID -5']),

  // CLIENT KILL
  s('CLIENT KILL old form unknown address', ['CLIENT KILL 1.2.3.4:5']),
  s('CLIENT KILL ADDR unknown', ['CLIENT KILL ADDR 1.2.3.4:5', 'CLIENT KILL LADDR 1.2.3.4:5']),
  s('CLIENT KILL ID unknown', ['CLIENT KILL ID 999999']),
  s('CLIENT KILL ID invalid', ['CLIENT KILL ID abc', 'CLIENT KILL ID 0', 'CLIENT KILL ID -1']),
  s('CLIENT KILL TYPE bogus', ['CLIENT KILL TYPE bogus']),
  s('CLIENT KILL USER unknown', ['CLIENT KILL USER nouser']),
  s('CLIENT KILL SKIPME invalid', ['CLIENT KILL TYPE pubsub SKIPME maybe']),
  s('CLIENT KILL unknown filter', ['CLIENT KILL bogus x', 'CLIENT KILL ID']),
  s('CLIENT KILL arity', ['CLIENT KILL']),
  s('CLIENT KILL TYPE pubsub kills a subscriber', [
    { c: 1, cmd: 'SUBSCRIBE ch' }, 'CLIENT KILL TYPE pubsub', { c: 1, cmd: 'PING' }, 'PUBLISH ch x',
  ]),
  s('CLIENT KILL TYPE pubsub without subscribers', ['CLIENT KILL TYPE pubsub']),
  s('CLIENT KILL TYPE master', ['CLIENT KILL TYPE master', 'CLIENT KILL TYPE replica']),

  // CLIENT NO-EVICT / NO-TOUCH
  s('CLIENT NO-EVICT on and off', ['CLIENT NO-EVICT on', 'CLIENT NO-EVICT OFF']),
  s('CLIENT NO-EVICT invalid', ['CLIENT NO-EVICT maybe', 'CLIENT NO-EVICT']),
  s('CLIENT NO-TOUCH on', ['CLIENT NO-TOUCH on', 'CLIENT NO-TOUCH off'], v('CLIENT NO-TOUCH was added in 7.2')),
  s('CLIENT SETINFO lib-name', ['CLIENT SETINFO lib-name mylib'], v('CLIENT SETINFO was added in 7.2')),

  // CLIENT REPLY
  s('CLIENT REPLY OFF suppresses replies until ON', [
    { cmd: 'CLIENT REPLY OFF', replies: 0 }, { cmd: 'SET a 1', replies: 0 }, { cmd: 'GET a', replies: 0 }, 'CLIENT REPLY ON', 'GET a',
  ]),
  s('CLIENT REPLY SKIP suppresses one reply', [{ cmd: 'CLIENT REPLY SKIP', replies: 0 }, { cmd: 'SET a 1', replies: 0 }, 'GET a', 'PING']),
  s('CLIENT REPLY ON replies OK', ['CLIENT REPLY ON']),
  s('CLIENT REPLY invalid', ['CLIENT REPLY maybe', 'CLIENT REPLY']),
  s('CLIENT REPLY OFF hides errors too', [{ cmd: 'CLIENT REPLY OFF', replies: 0 }, { cmd: 'INCR', replies: 0 }, 'CLIENT REPLY ON', 'PING']),

  // CLIENT PAUSE / UNPAUSE
  s('CLIENT PAUSE invalid timeout', ['CLIENT PAUSE abc', 'CLIENT PAUSE -1', 'CLIENT PAUSE 1.5']),
  s('CLIENT PAUSE invalid mode', ['CLIENT PAUSE 10 bogus', 'CLIENT PAUSE 10 WRITE extra']),
  s('CLIENT PAUSE arity', ['CLIENT PAUSE']),
  s('CLIENT UNPAUSE without a pause', ['CLIENT UNPAUSE', 'CLIENT UNPAUSE x']),
  s('CLIENT PAUSE WRITE lets reads through', ['SET k v', 'CLIENT PAUSE 5000 WRITE', { c: 1, cmd: 'GET k' }, 'CLIENT UNPAUSE'], { fresh: true }),
  s('CLIENT PAUSE WRITE delays a write until UNPAUSE', [
    'CLIENT PAUSE 5000 WRITE', { c: 1, cmd: 'SET k v', wait: false }, { sleep: 50 }, 'GET k', 'CLIENT UNPAUSE', { c: 1, read: 1 }, 'GET k',
  ], { fresh: true }),
  s('CLIENT PAUSE expires by itself', ['CLIENT PAUSE 50 WRITE', { c: 1, cmd: 'SET k v' }, 'GET k'], { fresh: true }),

  // CLIENT TRACKING / CACHING / GETREDIR / TRACKINGINFO
  s('CLIENT GETREDIR without tracking', ['CLIENT GETREDIR']),
  s('CLIENT TRACKING invalid mode', ['CLIENT TRACKING maybe', 'CLIENT TRACKING']),
  s('CLIENT TRACKING REDIRECT to an unknown client', ['CLIENT TRACKING ON REDIRECT 999999']),
  s('CLIENT TRACKING REDIRECT non-integer', ['CLIENT TRACKING ON REDIRECT abc']),
  s('CLIENT TRACKING PREFIX without BCAST', ['CLIENT TRACKING ON PREFIX a']),
  s('CLIENT TRACKING OPTIN and OPTOUT together', ['CLIENT TRACKING ON OPTIN OPTOUT']),
  s('CLIENT TRACKING BCAST with OPTIN', ['CLIENT TRACKING ON BCAST OPTIN']),
  s('CLIENT TRACKING unknown option', ['CLIENT TRACKING ON bogus']),
  s('CLIENT TRACKING OFF when off', ['CLIENT TRACKING OFF', 'CLIENT GETREDIR']),
  s('CLIENT CACHING without tracking', ['CLIENT CACHING YES', 'CLIENT CACHING NO']),
  s('CLIENT CACHING invalid', ['CLIENT TRACKING ON OPTIN', 'CLIENT CACHING maybe']),
  s('CLIENT CACHING NO in OPTIN mode', ['CLIENT TRACKING ON OPTIN', 'CLIENT CACHING NO']),
  s('CLIENT CACHING YES in OPTOUT mode', ['CLIENT TRACKING ON OPTOUT', 'CLIENT CACHING YES']),
  s('CLIENT TRACKING overlapping prefixes', ['CLIENT TRACKING ON BCAST PREFIX a PREFIX ab']),
  s('CLIENT TRACKINGINFO when off', ['CLIENT TRACKINGINFO']),
  s('CLIENT TRACKINGINFO with BCAST prefixes', ['CLIENT TRACKING ON BCAST PREFIX x: NOLOOP', 'CLIENT TRACKINGINFO']),
  s('CLIENT TRACKINGINFO with OPTIN', ['CLIENT TRACKING ON OPTIN', 'CLIENT TRACKINGINFO', 'CLIENT GETREDIR']),
  s('CLIENT TRACKING ON without REDIRECT', [
    { cmd: 'CLIENT ID', norm: anyNumber }, 'CLIENT TRACKING ON', 'CLIENT GETREDIR',
  ]),

  // CLIENT HELP / unknown subcommands
  s('CLIENT HELP shape', [{ cmd: 'CLIENT HELP', norm: shape }],
    v('CLIENT HELP lists SETINFO and NO-TOUCH (7.2), KILL ID/MAXAGE (7.4) and says "Print this help"')),
  s('CLIENT unknown subcommand', ['CLIENT bogus', 'CLIENT bogus a b']),
  s('CLIENT without subcommand', ['CLIENT']),
  s('CLIENT UNBLOCK unknown client', ['CLIENT UNBLOCK 999999', 'CLIENT UNBLOCK 999999 ERROR']),
  s('CLIENT UNBLOCK invalid', ['CLIENT UNBLOCK abc', 'CLIENT UNBLOCK 1 bogus']),

  // RESET / QUIT
  s('RESET reply', ['RESET']),
  s('RESET clears the name and db', ['CLIENT SETNAME n', 'SELECT 2', 'SET k v', 'RESET', 'CLIENT GETNAME', 'GET k']),
  s('RESET leaves MULTI', ['MULTI', 'SET k v', 'RESET', 'EXEC', 'GET k']),
  s('RESET ends subscriptions', [{ cmd: 'SUBSCRIBE ch' }, 'RESET', 'PING']),
  s('RESET switches back to RESP2', [{ cmd: 'HELLO 3', norm: hello }, 'RESET', 'HSET h f v', 'HGETALL h'], { proto: 3 }),
  s('RESET turns tracking off', ['CLIENT TRACKING ON OPTIN', 'RESET', 'CLIENT GETREDIR']),
  s('RESET arity', ['RESET x']),
  s('QUIT closes the connection', ['QUIT', 'PING']),
  s('QUIT with arguments', ['QUIT x', 'PING']),
  s('CLIENT KILL ID unknown with digits masked', [{ cmd: 'CLIENT KILL ID 123456789', norm: digits }]),
]);
