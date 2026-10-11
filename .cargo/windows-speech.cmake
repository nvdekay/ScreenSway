# cmake-rs 0.1.58 removes /O flags from its compiler arguments, then passes
# CMAKE_{C,CXX}_FLAGS_RELEASE without CMake's default /O2. A toolchain is read
# after those command-line cache values, so restore Release optimization here.
# Explicit /MD matches Rust's default dynamic MSVC CRT. No host-specific ISA.
set(CMAKE_C_FLAGS_RELEASE "/O2 /DNDEBUG /MD" CACHE STRING "Optimized native C" FORCE)
set(CMAKE_CXX_FLAGS_RELEASE "/O2 /DNDEBUG /MD" CACHE STRING "Optimized native C++" FORCE)
