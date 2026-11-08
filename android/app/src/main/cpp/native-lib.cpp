// JNI bridge to the embedded Node runtime (nodejs-mobile). Starts Node on the calling thread and
// redirects its stdout/stderr to logcat so service logs are visible with `adb logcat -s DashNode`.
#include <jni.h>
#include <string>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>
#include "node.h"

static const char *TAG = "DashNode";
static int pfd[2];
static pthread_t logThread;

static void *loggerThread(void *) {
    ssize_t n;
    char buf[1024];
    while ((n = read(pfd[0], buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_INFO, TAG, buf);
    }
    return nullptr;
}

static void startLogger() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pfd);
    dup2(pfd[1], 1);
    dup2(pfd[1], 2);
    if (pthread_create(&logThread, nullptr, loggerThread, nullptr) == 0) pthread_detach(logThread);
}

extern "C" JNIEXPORT void JNICALL
Java_local_dash_tv_NodeService_setEnv(JNIEnv *env, jobject, jstring key, jstring value) {
    const char *k = env->GetStringUTFChars(key, nullptr);
    const char *v = env->GetStringUTFChars(value, nullptr);
    setenv(k, v, 1);
    env->ReleaseStringUTFChars(key, k);
    env->ReleaseStringUTFChars(value, v);
}

extern "C" JNIEXPORT jint JNICALL
Java_local_dash_tv_NodeService_startNodeWithArguments(JNIEnv *env, jobject, jobjectArray arguments) {
    startLogger();
    jsize count = env->GetArrayLength(arguments);
    std::vector<std::string> storage;
    storage.reserve(count);
    for (jsize i = 0; i < count; i++) {
        auto js = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(js, nullptr);
        storage.emplace_back(c);
        env->ReleaseStringUTFChars(js, c);
    }
    // node::Start wants a contiguous argv buffer.
    size_t total = 0;
    for (auto &s : storage) total += s.size() + 1;
    char *buffer = (char *) calloc(total, 1);
    std::vector<char *> argv(count);
    char *cursor = buffer;
    for (jsize i = 0; i < count; i++) {
        memcpy(cursor, storage[i].c_str(), storage[i].size());
        argv[i] = cursor;
        cursor += storage[i].size() + 1;
    }
    int result = node::Start(count, argv.data());
    free(buffer);
    return result;
}
