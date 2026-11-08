cmake_minimum_required(VERSION 3.18)
project(dashtv)

add_library(native-lib SHARED native-lib.cpp)

# nodejs-mobile: prebuilt libnode.so + headers, unpacked by CI into app/libnode/{bin,include}
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/../../../libnode/bin/${ANDROID_ABI}/libnode.so)
include_directories(${CMAKE_SOURCE_DIR}/../../../libnode/include/node/)

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
