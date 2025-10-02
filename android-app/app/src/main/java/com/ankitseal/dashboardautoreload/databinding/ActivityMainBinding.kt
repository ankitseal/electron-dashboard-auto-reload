package com.ankitseal.dashboardautoreload.databinding

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import com.ankitseal.dashboardautoreload.R

class ActivityMainBinding private constructor(
    val root: View,
    val webContainer: FrameLayout,
    val fabSettings: View
) {
    companion object {
        fun inflate(inflater: LayoutInflater, parent: ViewGroup? = null, attachToParent: Boolean = false): ActivityMainBinding {
            val root = inflater.inflate(R.layout.activity_main, parent, attachToParent)
            val web = root.findViewById<FrameLayout>(R.id.web_container)
            val fab = root.findViewById<View>(R.id.fab_settings)
            return ActivityMainBinding(root, web, fab)
        }
    }
}
