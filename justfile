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

[doc('Install development dependencies')]
[group('Compile')]
install-deps os=BUN_OS cpu=BUN_CPU:
    {{ BUN_CMD }} install-deps --os {{ os }} --cpu {{ cpu }}

[doc('Install development dependencies and compile native binary for this platform')]
[group('Compile')]
build: install-deps
    just compile

[doc('Compile one native binary with argv0 command aliases')]
[group('Compile')]
compile os=BUN_OS cpu=BUN_CPU:
    mkdir -p {{ BUN_OUT }}/{{ os }}-{{ cpu }}
    {{ BUN_CMD }} build --compile --outfile={{ BUN_OUT }}/{{ os }}-{{ cpu }}/{{ CLI_BASENAME }} --target=bun-{{ os }}-{{ cpu }} {{ ENTRY }}
    ln -sfn {{ CLI_BASENAME }} {{ BUN_OUT }}/{{ os }}-{{ cpu }}/{{ CLI_BASENAME }}-append
    ln -sfn {{ CLI_BASENAME }} {{ BUN_OUT }}/{{ os }}-{{ cpu }}/{{ CLI_BASENAME }}-fixup
    ln -sfn {{ CLI_BASENAME }} {{ BUN_OUT }}/{{ os }}-{{ cpu }}/{{ CLI_BASENAME }}-tail

#-----------------------------------------------------------
### Cross Compilation
#-----------------------------------------------------------
[doc('Install development dependencies for all platforms')]
[group('X-Compile')]
install-deps-all:
    just install-deps linux x64
    just install-deps darwin arm64

[doc('Compile for all supported platforms')]
[group('X-Compile')]
compile-all:
    just compile linux x64
    just compile darwin arm64

[doc('Install development dependencies and Compile for all supported platforms')]
[group('X-Compile')]
build-all: install-deps-all compile-all

[doc('Remove generated build output')]
[group('Compile')]
clean:
    rm -rf {{ BUN_OUT }}

############################################################
### Installation
############################################################
INSTALL_DIR := env('HOME') / 'bin'
INSTALL_PATH := INSTALL_DIR / 'dlog'
OS_COMPILE_PATH := BUN_OUT / BUN_OS + '-' + BUN_CPU / CLI_BASENAME

[doc('Make and install compiled binary and symlinks to sub-commands')]
[group('Install')]
install: compile install-binary install-links

[doc('Install compiled binary')]
[group('Install')]
install-binary bin=INSTALL_PATH:
    cp -v {{ OS_COMPILE_PATH }} {{ bin }}
    @printf "✅ Copied application binary\n"

#-----------------------------------------------------------
### Links
#-----------------------------------------------------------
[doc('Install / create symlinks pointing to dlog bin at given path')]
[group('Install')]
install-links bin=INSTALL_PATH to_dir=INSTALL_DIR:
    #!/usr/bin/env zsh
    function linkit() {
        local link_name="$1"
        local to_path="{{ to_dir}}/$link_name"
        local bin="{{bin}}"
        if [[ -s $to_path ]]; then
            printf "☑ Skipping $link_name Symlink\n"
        else
            printf "✅ Creating $link_name Symlink\n"
            ln -s ${bin} ${to_path}
        fi
    }
    linkit 'dlog-append'
    linkit 'dlog-fixup'
    linkit 'dlog-tail'

[group('Install')]
[doc('Remove symlinks from given dir')]
uninstall-links dir=INSTALL_DIR:
    rm -v {{ dir / 'dlog-append' }} || true
    rm -v {{ dir / 'dlog-fixup' }} || true
    rm -v {{ dir / 'dlog-tail' }} || true

#-----------------------------------------------------------
### Binary Installation
#-----------------------------------------------------------


############################################################
### project targets
############################################################
alias r := run
[doc('Run dlog from source')]
[group('Development')]
run *args:
    {{ BUN_CMD }} run {{ ENTRY }} {{ args }}
