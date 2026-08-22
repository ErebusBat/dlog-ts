# vim: set ft=just ts=4 sw=4 sts=4 et ai si sta:

############################################################
### project variables
############################################################
CLI_BASENAME := 'dlog'
ENTRY := 'src/index.ts'

############################################################
### development
############################################################
#-----------------------------------------------------------
#-- Check (Test + TypeScript)
#-----------------------------------------------------------
[default]
[doc('Run TypeScript Checks and Tests')]
[group('Development')]
check: tsc test

alias watch := check-watch
[doc('Run TypeScript Checks and Tests evertime files change')]
[group('Development')]
check-watch:
    {{ BUN_CMD }} x -- concurrently \
        -p name --pad-prefix \
        --names 'tsc,test' \
        'bun run tsc:watch' \
        'bun run test:watch'

#-----------------------------------------------------------
#-- Check (Test + TypeScript)
#-----------------------------------------------------------
alias f := format
alias fmt := format
[doc('Format source files')]
[group('Development')]
format:
    just --fmt
    {{ BUN_CMD }} run format

#-----------------------------------------------------------
#-- Test
#-----------------------------------------------------------
alias t := test
[doc('Run tests')]
[group('Development')]
test *args:
    {{ BUN_CMD }} run test {{ args }}

[doc('Run tests every time files change')]
[group('Development')]
test-watch:
    {{ BUN_CMD }} run test:watch

#-----------------------------------------------------------
#-- TypeScript (tsc)
#-----------------------------------------------------------
[doc('Check TypeScript')]
[group('Development')]
tsc *args:
    tsc --noEmit {{ args }}

[doc('Check TypeScript every time files change')]
[group('Development')]
tsc-watch *args:
    tsc --noEmit --watch {{ args }}

############################################################
### Package Management
# ###########################################################
pack-try:
    {{ BUN_CMD }} pm pack --dry-run

############################################################
### compilation variables
############################################################
BUN_OUT := 'dist'
BUN_CMD := 'mise x -- bun'
BUN_CPU := if arch() == "aarch64" { "arm64" } else if arch() == "x86_64" { "x64" } else { arch() }
BUN_OS := if os() == "macos" { "darwin" } else { os() }

[doc('Install dependencies')]
[group('Compile')]
install os=BUN_OS cpu=BUN_CPU:
    {{ BUN_CMD }} install --os {{ os }} --cpu {{ cpu }}

[doc('Install deps and compile native binary for this platform')]
[group('Compile')]
build: install
    just compile

[doc('Compile one native binary with argv0 command aliases')]
[group('Compile')]
compile os=BUN_OS cpu=BUN_CPU:
    mkdir -p {{ BUN_OUT }}/{{ os }}-{{ cpu }}
    {{ BUN_CMD }} build --compile --outfile={{ BUN_OUT }}/{{ os }}-{{ cpu }}/{{ CLI_BASENAME }} --target=bun-{{ os }}-{{ cpu }} {{ ENTRY }}
    ln -sfn {{ CLI_BASENAME }} {{ BUN_OUT }}/{{ os }}-{{ cpu }}/{{ CLI_BASENAME }}-append
    ln -sfn {{ CLI_BASENAME }} {{ BUN_OUT }}/{{ os }}-{{ cpu }}/{{ CLI_BASENAME }}-fixup

#-----------------------------------------------------------
### Cross Compilation
#-----------------------------------------------------------
[doc('All deps for all platforms')]
[group('X-Compile')]
install-all:
    just install linux x64
    just install darwin arm64

[doc('Compile for all supported platforms')]
[group('X-Compile')]
compile-all:
    just compile linux x64
    just compile darwin arm64

[doc('Install and Compile for all supported platforms')]
[group('X-Compile')]
build-all: install-all compile-all

[doc('Remove generated build output')]
[group('Compile')]
clean:
    rm -rf {{ BUN_OUT }}

############################################################
### project targets
############################################################
alias r := run
[doc('Run dlog from source')]
[group('Development')]
run *args:
    {{ BUN_CMD }} run {{ ENTRY }} {{ args }}
