# Security

## What the Graph Runtime trusts

The runtime (`wire runtime`) serves the user it runs as and nobody else. Its socket folder and data
folder are 0700 and its files 0600, so only that user's processes reach them. A client is trusted
for what its token allows and nothing more: the CLI's token can observe, start a graph whose manual
trigger says `agents: true` and push events, but never enable a graph, control a run or take a
worker's tasks. Tokens are compared in constant time and can be revoked.

Credentials do not belong in the runtime. A host keeps connection secrets and the human's own acts
(enabling a graph, answering an approval) and sends the runtime neither a secret nor a token of its
own; a step's input and output carry none.

On Linux the lock that keeps one runtime per data folder is an abstract Unix socket, which has no
permissions of its own; its name comes from `lock-id`, a random value in the private data folder,
so another user cannot take it first.

## The known gap

The runtime does not defend against another process of the same user that reads or writes its data
folder: such a process can read the CLI's token, write a token file into `tokens/` with any rights,
rewrite `enabled.json` to enable a graph, or edit a journal. Nothing on the socket raises a
client's rights: there is no pairing call, so a process that holds only the CLI's token needs such
a file write to get more. That is the same class of risk as any file the user's own programs can write, and it is
not in scope. Run untrusted programs as another user or in a sandbox.

## Reporting a vulnerability

Open a private security advisory on https://github.com/aurigax-ai/wire/security/advisories.
